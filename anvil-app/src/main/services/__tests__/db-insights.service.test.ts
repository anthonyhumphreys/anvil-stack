import { describe, expect, it, vi } from 'vitest';
import { getDb } from '../../db/database.js';

vi.mock('../../db/database.js', () => ({
  getDb: vi.fn(),
}));

vi.mock('../llm.service.js', () => ({
  callLlm: vi.fn(),
}));

vi.mock('../../utils/prompt-templates.js', () => ({
  loadPromptTemplate: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => null),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
}));

import {
  buildFallbackAnalysis,
  getLatestAnalysis,
  inferArtifactCategory,
  parseExportSnapshot,
  parseSqlSnapshot,
} from '../db-insights.service.js';

describe('inferArtifactCategory', () => {
  it('classifies mixed SQL exports from their contents', () => {
    const category = inferArtifactCategory(
      'finance.sql',
      `
CREATE TABLE [dbo].[Customers] ([CustomerId] INT NOT NULL)
GO
CREATE PROCEDURE [dbo].[usp_GetCustomers]
AS
BEGIN
  SELECT * FROM [dbo].[Customers]
END
GO
`,
    );

    expect(category).toBe('mixed');
  });
});

describe('parseSqlSnapshot', () => {
  it('extracts tables, procedures, counts, and relationships from SSMS exports', () => {
    const snapshot = parseSqlSnapshot([
      `
USE [FinanceDb]
GO
CREATE TABLE [dbo].[Customers] (
  [CustomerId] INT NOT NULL,
  [CustomerCode] NVARCHAR(50) NOT NULL,
  [Name] NVARCHAR(100) NOT NULL,
  PRIMARY KEY ([CustomerId])
)
GO
CREATE TABLE [dbo].[Invoices] (
  [InvoiceId] INT NOT NULL,
  [CustomerId] INT NOT NULL,
  [InvoiceNumber] NVARCHAR(50) NOT NULL,
  CONSTRAINT [FK_Invoices_Customers] FOREIGN KEY ([CustomerId]) REFERENCES [dbo].[Customers]([CustomerId])
)
GO
`,
      `
CREATE VIEW [dbo].[vInvoiceSummary]
AS
SELECT [InvoiceId], [CustomerId] FROM [dbo].[Invoices]
GO

CREATE FUNCTION [dbo].[fnInvoiceCount]()
RETURNS INT
AS
BEGIN
  RETURN 0
END
GO

CREATE PROCEDURE [dbo].[usp_GetCustomerInvoices]
AS
BEGIN
  SELECT c.[Name], i.[InvoiceNumber]
  FROM [dbo].[Customers] c
  INNER JOIN [dbo].[Invoices] i ON i.[CustomerId] = c.[CustomerId]
END
GO
`,
    ]);

    expect(snapshot.databaseName).toBe('FinanceDb');
    expect(snapshot.tableCount).toBe(2);
    expect(snapshot.procedureCount).toBe(1);
    expect(snapshot.viewCount).toBe(1);
    expect(snapshot.functionCount).toBe(1);
    expect(snapshot.tables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          qualifiedName: 'dbo.Customers',
          columnCount: 3,
          keyColumns: expect.arrayContaining(['CustomerId', 'CustomerCode']),
        }),
        expect.objectContaining({
          qualifiedName: 'dbo.Invoices',
          columnCount: 3,
        }),
      ]),
    );
    expect(snapshot.storedProcedures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          qualifiedName: 'dbo.usp_GetCustomerInvoices',
          referencedObjects: expect.arrayContaining(['dbo.Customers', 'dbo.Invoices']),
        }),
      ]),
    );
    expect(snapshot.relationships).toContain('dbo.Invoices -> dbo.Customers');
  });
});

describe('parseExportSnapshot', () => {
  it('detects MongoDB documents and keeps them out of SQL table counts', () => {
    const snapshot = parseExportSnapshot([
      {
        fileName: 'customers.json',
        content: JSON.stringify([
          { _id: { $oid: 'one' }, name: 'Private Name', profile: { tier: 'gold' } },
          { _id: { $oid: 'two' }, name: 'Another Name', profile: { tier: 'silver' } },
        ]),
      },
    ]);

    expect(snapshot.structure.technology).toBe('mongodb');
    expect(snapshot.structure.entityCount).toBe(1);
    expect(snapshot.structure.recordCount).toBe(2);
    expect(snapshot.structure.entities[0]).toMatchObject({
      name: 'customers',
      kind: 'collection',
      fields: expect.arrayContaining(['_id', '_id.$oid', 'name', 'profile', 'profile.tier']),
      recordCount: 2,
    });
    expect(snapshot.tableCount).toBe(0);
    expect(JSON.stringify(snapshot)).not.toContain('Private Name');
    expect(buildFallbackAnalysis(snapshot).summary).toContain('2 document(s)');
  });

  it('parses DynamoDB typed item exports without calling them SQL tables', () => {
    const snapshot = parseExportSnapshot([
      {
        fileName: 'orders.json',
        content: JSON.stringify(
          {
            Items: [
              {
                PK: { S: 'ORDER#1' },
                total: { N: '25' },
                metadata: { M: { source: { S: 'web' } } },
              },
              { PK: { S: 'ORDER#2' }, total: { N: '40' } },
            ],
          },
          null,
          2,
        ),
      },
    ]);

    expect(snapshot.structure.technology).toBe('dynamodb');
    expect(snapshot.structure.recordCount).toBe(2);
    expect(snapshot.structure.entities[0]).toMatchObject({
      kind: 'item-export',
      fields: ['PK', 'metadata', 'total'],
    });
    expect(snapshot.tableCount).toBe(0);
  });

  it('parses DynamoDB Item NDJSON export records', () => {
    const snapshot = parseExportSnapshot([
      {
        fileName: 'data.json',
        content: [
          JSON.stringify({ Item: { PK: { S: 'ORDER#1' }, total: { N: '25' } } }),
          JSON.stringify({ Item: { PK: { S: 'ORDER#2' }, total: { N: '40' } } }),
        ].join('\n'),
      },
    ]);
    expect(snapshot.structure.technology).toBe('dynamodb');
    expect(snapshot.structure.recordCount).toBe(2);
    expect(snapshot.structure.entities[0]).toMatchObject({
      kind: 'item-export',
      fields: ['PK', 'total'],
    });
  });

  it('summarises Redis TYPE output by observed key pattern and type', () => {
    const snapshot = parseExportSnapshot([
      {
        fileName: 'redis.txt',
        content:
          'TYPE session:123\nhash\nTYPE session:123\nhash\nTYPE session:456\nhash\nTYPE queue:1\nlist\nTYPE user:alice@example.com\nhash\nTYPE removed:1\nnone',
      },
    ]);

    expect(snapshot.structure.technology).toBe('redis');
    expect(snapshot.structure.keyCount).toBe(4);
    expect(snapshot.structure.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'key shape (:; 2 segments)',
          keyCount: 3,
          notes: 'Observed Redis data type(s): hash, list. Key names and values were omitted.',
        }),
        expect.objectContaining({ name: 'key shape (.:; 3 segments)', keyCount: 1 }),
      ]),
    );
    expect(JSON.stringify(snapshot)).not.toContain('session');
    expect(JSON.stringify(snapshot)).not.toContain('123');
    expect(JSON.stringify(snapshot)).not.toContain('alice');
    expect(JSON.stringify(snapshot)).not.toContain('@example.com');
    expect(JSON.stringify(snapshot)).not.toContain('removed');
    expect(snapshot.tableCount).toBe(0);
  });

  it('keeps generic SQL labelled by relational structure when the dialect is unknown', () => {
    const snapshot = parseExportSnapshot([
      { fileName: 'schema.sql', content: 'CREATE TABLE customers (id INTEGER, email TEXT);' },
    ]);

    expect(snapshot.structure.technology).toBe('sql');
    expect(snapshot.structure.entities[0]).toMatchObject({ name: 'customers', kind: 'table' });
    expect(snapshot.tableCount).toBe(1);
  });

  it('splits single-line columns without splitting nested type commas', () => {
    const snapshot = parseExportSnapshot([
      {
        fileName: 'mysql.sql',
        content:
          'CREATE TABLE invoices (id BIGINT, amount DECIMAL(10, 2), note VARCHAR(255)) ENGINE=InnoDB;',
      },
    ]);
    expect(snapshot.tables[0]).toMatchObject({
      columnCount: 3,
      fields: ['id', 'amount', 'note'],
    });
  });

  it.each([
    ['postgresql', 'CREATE TABLE public.users (id SERIAL PRIMARY KEY, email TEXT);'],
    ['mysql', 'CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, email TEXT);'],
    ['sqlite', 'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT);'],
  ] as const)('detects %s DDL', (technology, content) => {
    const snapshot = parseExportSnapshot([{ fileName: 'schema.sql', content }]);
    expect(snapshot.structure.technology).toBe(technology);
    expect(snapshot.tableCount).toBe(1);
  });

  it('parses PostgreSQL pg_dump tables, external foreign keys, views, functions, and procedures', () => {
    const snapshot = parseExportSnapshot([
      {
        fileName: 'schema.sql',
        content: `
CREATE SEQUENCE public.orders_id_seq;
CREATE TABLE public.orders (
  id bigint NOT NULL DEFAULT nextval('public.orders_id_seq'::regclass),
  customer_id bigint NOT NULL,
  amount numeric(10, 2) NOT NULL
);
CREATE TABLE public.customers (id bigint NOT NULL);
ALTER TABLE ONLY public.orders
  ADD CONSTRAINT orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id);
CREATE OR REPLACE VIEW public.order_totals AS SELECT customer_id, sum(amount) FROM public.orders GROUP BY customer_id;
CREATE OR REPLACE FUNCTION public.refresh_order_total() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RETURN NEW;
END;
$$;
CREATE OR REPLACE PROCEDURE public.rebuild_order_totals() LANGUAGE SQL AS $$ SELECT 1; $$;
`,
      },
    ]);
    expect(snapshot.structure.technology).toBe('postgresql');
    expect(snapshot.tables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ qualifiedName: 'public.orders', columnCount: 3 }),
        expect.objectContaining({ qualifiedName: 'public.customers', columnCount: 1 }),
      ]),
    );
    expect(snapshot.relationships).toContain('public.orders -> public.customers');
    expect(snapshot.viewCount).toBe(1);
    expect(snapshot.functionCount).toBe(1);
    expect(snapshot.procedureCount).toBe(1);
  });

  it('parses MySQL dump table bodies with nested type parentheses and trailing engine options', () => {
    const snapshot = parseExportSnapshot([
      {
        fileName: 'mysql.sql',
        content:
          'CREATE TABLE invoices (\n  id BIGINT NOT NULL,\n  amount DECIMAL(10, 2) NOT NULL,\n  note VARCHAR(255)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;',
      },
    ]);
    expect(snapshot.structure.technology).toBe('mysql');
    expect(snapshot.tables[0]).toMatchObject({
      name: 'invoices',
      columnCount: 3,
      fields: ['id', 'amount', 'note'],
    });
  });

  it('accepts stored-procedure-only SQL exports', () => {
    const snapshot = parseExportSnapshot([
      {
        fileName: 'procedures.sql',
        content: 'USE [FinanceDb]\nGO\nCREATE PROCEDURE [dbo].[usp_ReadLedger] AS SELECT 1\nGO',
      },
    ]);
    expect(snapshot.structure.technology).toBe('sql-server');
    expect(snapshot.tableCount).toBe(0);
    expect(snapshot.procedureCount).toBe(1);
    expect(snapshot.storedProcedures[0].qualifiedName).toBe('dbo.usp_ReadLedger');
  });

  it('treats generic SQL files as compatible with a detected dialect', () => {
    const snapshot = parseExportSnapshot([
      { fileName: 'users.sql', content: 'CREATE TABLE public.users (id SERIAL PRIMARY KEY);' },
      { fileName: 'invoices.sql', content: 'CREATE TABLE invoices (id INTEGER PRIMARY KEY);' },
    ]);
    expect(snapshot.structure.technology).toBe('postgresql');
    expect(snapshot.tables.map((table) => table.qualifiedName)).toEqual([
      'public.invoices',
      'public.users',
    ]);
  });

  it('unwraps MongoDB document wrappers and rejects mixed malformed records', () => {
    const snapshot = parseExportSnapshot([
      {
        fileName: 'wrapped.json',
        content: JSON.stringify({ document: { _id: 'one', name: 'Redacted' } }),
      },
    ]);
    expect(snapshot.structure.entities[0].fields).toContain('name');
    expect(snapshot.structure.entities[0].fields).not.toContain('document.name');
    expect(() =>
      parseExportSnapshot([
        {
          fileName: 'mixed.json',
          content: JSON.stringify([{ _id: 'one', name: 'Redacted' }, { unrelated: true }]),
        },
      ]),
    ).toThrow(/do not all match/);
  });

  it('rejects non-DynamoDB records mixed into a typed item export', () => {
    expect(() =>
      parseExportSnapshot([
        {
          fileName: 'mixed.json',
          content: JSON.stringify([{ PK: { S: 'ORDER#1' } }, { unrelated: true }]),
        },
      ]),
    ).toThrow(/do not all match/);
  });

  it('returns useful errors for invalid and mixed technology exports', () => {
    expect(() =>
      parseExportSnapshot([{ fileName: 'data.json', content: '{"name":"unknown"}' }]),
    ).toThrow(/do not look like supported/);
    expect(() =>
      parseExportSnapshot([
        { fileName: 'schema.sql', content: 'USE [FinanceDb]\nCREATE TABLE [dbo].[Order] (Id INT)' },
        { fileName: 'redis.txt', content: 'TYPE session:1\nstring' },
      ]),
    ).toThrow(/mix relational SQL/);
    expect(() =>
      parseExportSnapshot([
        { fileName: 'schema.sql', content: 'CREATE TABLE x (id INT);' },
        { fileName: 'redis.txt', content: 'TYPE a\nstring' },
      ]),
    ).toThrow(/mix relational SQL with redis/);
  });
});

describe('persisted analysis compatibility', () => {
  it('loads existing SQL analyses whose snapshot has no technology metadata', () => {
    const row = {
      id: 'analysis-1',
      workspace_id: 'workspace-1',
      artifact_ids: '[]',
      status: 'completed',
      summary: 'Existing SQL summary',
      database_name: 'FinanceDb',
      table_count: 2,
      procedure_count: 1,
      view_count: 0,
      function_count: 0,
      tables_json: '[]',
      procedures_json: '[]',
      relationships_json: '[]',
      risks_json: '[]',
      recommended_questions_json: '[]',
      raw_snapshot_json: JSON.stringify({ tableCount: 2, tables: [] }),
      started_at: '2026-10-09 12:00:00',
      completed_at: '2026-10-09 12:01:00',
    };
    vi.mocked(getDb).mockReturnValue({
      prepare: () => ({ get: () => row }),
    } as never);

    const analysis = getLatestAnalysis('workspace-1');

    expect(analysis?.summary).toBe('Existing SQL summary');
    expect(analysis?.tableCount).toBe(2);
    expect(analysis?.structure).toBeUndefined();
  });
});
