import { patrimonioDoDia } from "./src/data/patrimonio.js";
import { cortesAbertos } from "./src/data/producao.js";
const p = await patrimonioDoDia();
console.log("emProducao:", JSON.stringify(p?.emProducao));
console.log("semSubirNoSite:", p?.semSubirNoSite.pecas, "peças em", p?.semSubirNoSite.cortes, "corte(s)");
console.log("loja:", p?.loja.pecas, "peças");
const abertos = await cortesAbertos();
console.log("cortesAbertos:", abertos.length, "| peças:", abertos.reduce((s, c) => s + c.pecas, 0));
