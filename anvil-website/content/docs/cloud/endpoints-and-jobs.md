---
title: Endpoints and jobs
navTitle: Endpoints and jobs
description: Define custom HTTP endpoints and scheduled background jobs in Anvil Cells.
product: Anvil Cloud
section: Architecture
order: 117
---

# Endpoints and jobs

Cells can declare custom HTTP endpoints and background jobs in addition to queries and mutations.

## Endpoints

Endpoints are custom HTTP routes that do not fit the query/mutation pattern. They are useful for:

- Webhook receivers.
- File uploads.
- Custom API shapes.
- Proxying to external services.

### Definition

```ts
import { endpoint } from "@anvil-cloud/runtime";

export default app({
  endpoints: {
    webhook: endpoint({
      method: "POST",
      path: "/webhooks/stripe",
      handler: async (ctx) => {
        const payload = ctx.request.body;
        // verify signature, record event, enqueue job
        return { received: true };
      }
    })
  }
});
```

### Request context

Endpoint handlers receive the same `ctx` as queries and mutations, plus `ctx.request.body`, `ctx.request.headers`, and `ctx.request.query`.

### Routing

Local runtime maps `/api/*` to declared endpoints. The endpoint path is relative to `/api`:

```txt
POST /api/webhooks/stripe  ->  webhook endpoint
```

AWS preview routes API Gateway or Lambda Function URL events to the same endpoint handler.

## Jobs

Jobs are background handlers that run outside the request path.

### On-demand jobs

```ts
import { job } from "@anvil-cloud/runtime";

export default app({
  jobs: {
    sendEmail: job({
      handler: async (ctx, payload) => {
        // send email, update status
      }
    })
  }
});
```

Enqueue from a query, mutation, or endpoint:

```ts
await ctx.jobs.enqueue("sendEmail", { to: user.email, subject: "Welcome" });
```

### Scheduled jobs

```ts
import { job } from "@anvil-cloud/runtime";

export default app({
  capabilities: {
    scheduledJobs: true
  },
  jobs: {
    nightlyCleanup: job({
      schedule: "0 2 * * *",
      handler: async (ctx) => {
        // run cleanup
      }
    })
  }
});
```

Scheduled jobs require `capabilities.scheduledJobs`. Guard rejects scheduled jobs without the capability declaration.

### Local job execution

Local runtime stores queued jobs in `.anvil/local/jobs.json` and runs them on a simple scheduler. You can also trigger a job manually:

```bash
curl -X POST http://localhost:8787/_anvil/jobs/run/sendEmail \
  -H "Content-Type: application/json" \
  -d '{"to":"user@example.com"}'
```

### AWS job execution

AWS preview maps:

- On-demand jobs to SQS queues + Lambda triggers.
- Scheduled jobs to EventBridge rules invoking the Lambda runtime.

### Limitations

- Local job scheduling is simple and best-effort. It is not a production job scheduler.
- AWS event publishing (`ctx.events.publish`) is still unsupported in the AWS preview adapter.
- Job retries and dead-letter handling are adapter-specific.

## Read next

- [Cell contract](/docs/cloud/cell-contract)
- [Local runtime](/docs/cloud/local-runtime)
- [AWS preview](/docs/cloud/aws-preview)
