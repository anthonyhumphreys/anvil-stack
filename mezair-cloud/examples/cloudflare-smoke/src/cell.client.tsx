import { createClient } from "@mezair-cloud/client";

const client = createClient();

document.querySelector<HTMLDivElement>("#root")!.textContent =
  "Mezair Cloudflare smoke client ready";

void client;
