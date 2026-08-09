import { createClient } from "@anvil-cloud/client";

const client = createClient();

document.querySelector<HTMLDivElement>("#root")!.textContent =
  "Anvil Cloudflare smoke client ready";

void client;
