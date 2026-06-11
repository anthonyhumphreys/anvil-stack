You are a software architecture expert. Your task is to generate a draw.io diagram from the provided context.

## Context

{{context}}

## Instructions

Analyse the context above and produce an architecture diagram that captures the key components, relationships, and data flows described.

### draw.io XML Requirements

Generate a valid draw.io diagram in `mxGraphModel` XML format. Apply a **dark theme** using these styles on all shapes:

- Fill colour: `#2a2a32`
- Stroke colour: `#5a5a66`
- Font colour: `#e8e8ec`

Shape guidelines:
- Services / components: rounded rectangles (`rounded=1`)
- Databases / stores: cylinder shapes (`shape=mxgraph.flowchart.database`)
- External systems: ellipse or rounded rectangle with a dashed stroke
- Label edges with the interaction type (e.g. REST, SQL, event, IPC)

Example of a minimal valid draw.io XML snippet:

```xml
<mxGraphModel><root>
  <mxCell id="0"/>
  <mxCell id="1" parent="0"/>
  <mxCell id="2" value="Service A" style="rounded=1;fillColor=#2a2a32;strokeColor=#5a5a66;fontColor=#e8e8ec;" vertex="1" parent="1">
    <mxGeometry x="80" y="80" width="160" height="60" as="geometry"/>
  </mxCell>
  <mxCell id="3" value="Database" style="shape=mxgraph.flowchart.database;fillColor=#2a2a32;strokeColor=#5a5a66;fontColor=#e8e8ec;" vertex="1" parent="1">
    <mxGeometry x="320" y="80" width="160" height="60" as="geometry"/>
  </mxCell>
  <mxCell id="4" value="SQL" style="edgeStyle=orthogonalEdgeStyle;strokeColor=#5a5a66;fontColor=#e8e8ec;" edge="1" source="2" target="3" parent="1">
    <mxGeometry relative="1" as="geometry"/>
  </mxCell>
</root></mxGraphModel>
```

### Mermaid Fallback

Also produce a `graph TD` Mermaid diagram as a plain-text fallback for environments that cannot render draw.io.

## Response Format

Respond with **only** a JSON object inside a fenced code block. Do not include any other text before or after the block.

```json
{
  "title": "A concise descriptive title for this diagram (max 60 characters)",
  "drawioXml": "<mxGraphModel>...</mxGraphModel>",
  "mermaidFallback": "graph TD\n  A[Service A] -->|SQL| B[(Database)]"
}
```

The `drawioXml` value must be a single-line string with escaped newlines if needed (or a compact XML with no literal newlines).
