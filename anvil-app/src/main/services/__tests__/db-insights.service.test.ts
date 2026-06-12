import { describe, expect, it, vi } from 'vitest';

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

import { inferArtifactCategory, parseSqlSnapshot } from '../db-insights.service.js';

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
