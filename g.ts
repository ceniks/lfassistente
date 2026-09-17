import { producaoAtual } from './src/data/producao.js';
import { fecharConexoes } from './src/data/mcp-client.js';
const p = await producaoAtual();
console.log(JSON.stringify(p, null, 1));
await fecharConexoes(); process.exit(0);
