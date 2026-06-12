import { loadConfig } from "@anvilstack/config";
import { buildGateway } from "./app.js";

const config = loadConfig();
const app = buildGateway({ config });

await app.listen({ host: config.HOST, port: config.PORT });
