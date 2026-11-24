import { producaoAtual } from "./src/data/producao.js";
import { config } from "./src/config.js";
console.log("CORTEPRO_MCP_URL configurado:", Boolean(config().CORTEPRO_MCP_URL));
try {
  console.log("producaoAtual:", JSON.stringify(await producaoAtual(), null, 1));
} catch (e) {
  console.log("ERRO:", e instanceof Error ? e.message : e);
}
