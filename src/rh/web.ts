/**
 * A página de holerites: sobe o PDF, confere a lista, envia.
 *
 * Mesmo serviço do assistente, rota própria. Três cuidados que a página impõe
 * porque aqui circula salário de gente:
 *
 * **Senha.** A rota é pública na internet, então nada responde sem o cookie
 * assinado que só sai depois da senha (`RH_SENHA`). Sem a senha configurada a
 * página inteira fica desligada — é melhor não existir do que existir aberta.
 *
 * **Nada é enviado sem conferência.** O PDF é separado, casado com o cadastro
 * e mostrado numa tabela. O envio é outro clique, e quem não tem e-mail ou
 * ficou ambíguo aparece em vermelho, sem caixa para marcar.
 *
 * **O lote vive na memória.** Sobe, confere, envia, acabou. Nenhum holerite é
 * gravado em disco no servidor: se o processo reiniciar, some tudo e é só
 * subir o PDF de novo.
 */
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { config } from "../config.js";
import { dividir } from "./divisor.js";
import { acharFuncionaria, carregarCadastro, salvarCadastroDeCsv } from "./cadastro.js";
import { corpoDoEmail, mesDeReferencia, tratamentoDe } from "./fluxo.js";
import { enviarPeloGmail, temGmail } from "./gmail.js";
import { enviarEmail, temEnvioDeEmail } from "./email.js";

interface Item {
  id: string;
  nome: string;
  email: string | null;
  paginas: number[];
  pdf: Buffer;
}

interface LoteWeb {
  criadoEm: number;
  mes: string;
  itens: Item[];
  paginasSemNome: number[];
  paginasRepetidas: number[];
  totalDePaginas: number;
}

const lotes = new Map<string, LoteWeb>();
const VALIDADE = 2 * 60 * 60 * 1000;

function limpar(): void {
  for (const [id, l] of lotes) if (Date.now() - l.criadoEm > VALIDADE) lotes.delete(id);
}

/* ------------------------------------------------------------------ *
 * Sessão
 * ------------------------------------------------------------------ */

const segredo = () => config().RH_SENHA ?? "";

function assinar(ate: number): string {
  const h = createHmac("sha256", segredo()).update(String(ate)).digest("hex");
  return `${ate}.${h}`;
}

function valeCookie(valor?: string): boolean {
  if (!valor) return false;
  const [ate, assinatura] = valor.split(".");
  if (!ate || !assinatura || Number(ate) < Date.now()) return false;
  const esperado = createHmac("sha256", segredo()).update(ate).digest("hex");
  const a = Buffer.from(assinatura);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

const cookieDaRequisicao = (req: Request) =>
  (req.header("cookie") ?? "")
    .split(";")
    .map((p) => p.trim().split("="))
    .find(([k]) => k === "rh")?.[1];

function exigirSessao(req: Request, res: Response, proximo: NextFunction): void {
  if (!config().RH_SENHA) {
    res.status(503).json({ erro: "RH_SENHA não configurada no servidor" });
    return;
  }
  if (!valeCookie(cookieDaRequisicao(req))) {
    res.status(401).json({ erro: "sessão expirada" });
    return;
  }
  proximo();
}

/* ------------------------------------------------------------------ *
 * Rotas
 * ------------------------------------------------------------------ */

export function rotasDeRh(): Router {
  const r = Router();

  r.get("/", (_req, res) => {
    res.type("html").send(PAGINA);
  });

  r.post("/entrar", (req, res) => {
    const senha = config().RH_SENHA;
    if (!senha) {
      res.status(503).json({ erro: "RH_SENHA não configurada no servidor" });
      return;
    }
    const enviada = String((req.body as { senha?: string })?.senha ?? "");
    const a = Buffer.from(enviada);
    const b = Buffer.from(senha);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(401).json({ erro: "senha incorreta" });
      return;
    }
    const ate = Date.now() + 8 * 60 * 60 * 1000;
    res.setHeader(
      "Set-Cookie",
      `rh=${assinar(ate)}; Path=/rh; HttpOnly; SameSite=Strict; Secure; Max-Age=${8 * 3600}`,
    );
    res.json({ ok: true });
  });

  r.get("/estado", exigirSessao, async (_req, res) => {
    const cadastro = await carregarCadastro();
    res.json({
      cadastro: cadastro.length,
      envio: temGmail() ? "Gmail" : temEnvioDeEmail() ? "SMTP" : null,
    });
  });

  r.post("/cadastro", exigirSessao, async (req, res) => {
    const csv = String((req.body as { csv?: string })?.csv ?? "");
    const lista = await salvarCadastroDeCsv(csv);
    res.json({ cadastro: lista.length });
  });

  r.post("/analisar", exigirSessao, async (req, res) => {
    try {
      limpar();
      const corpo = req.body as { pdf?: string; nome?: string };
      const pdf = Buffer.from(String(corpo.pdf ?? "").split(",").pop() ?? "", "base64");
      if (!pdf.length) {
        res.status(400).json({ erro: "PDF vazio" });
        return;
      }

      const divisao = await dividir(pdf);
      const cadastro = await carregarCadastro();

      const itens: Item[] = divisao.holerites.map((h) => ({
        id: randomUUID(),
        nome: h.nome,
        email: acharFuncionaria(h.nome, cadastro)?.email ?? null,
        paginas: h.paginas,
        pdf: h.pdf,
      }));

      const id = randomUUID();
      lotes.set(id, {
        criadoEm: Date.now(),
        mes: mesDeReferencia(corpo.nome ?? "", new Date()),
        itens,
        paginasSemNome: divisao.paginasSemNome,
        paginasRepetidas: divisao.paginasRepetidas,
        totalDePaginas: divisao.totalDePaginas,
      });

      res.json({
        id,
        mes: lotes.get(id)!.mes,
        totalDePaginas: divisao.totalDePaginas,
        paginasSemNome: divisao.paginasSemNome,
        paginasRepetidas: divisao.paginasRepetidas,
        itens: itens.map((i) => ({
          id: i.id,
          nome: i.nome,
          email: i.email,
          paginas: i.paginas,
          tratamento: tratamentoDe(i.nome),
          tamanho: i.pdf.length,
        })),
      });
    } catch (e) {
      console.error("[rh] análise falhou:", e);
      res.status(500).json({ erro: e instanceof Error ? e.message : String(e) });
    }
  });

  /** O PDF de uma pessoa, para conferir antes de enviar. */
  r.get("/pdf/:lote/:item", exigirSessao, (req, res) => {
    const idDoLote = String(req.params.lote);
    const idDoItem = String(req.params.item);
    const item = lotes.get(idDoLote)?.itens.find((i) => i.id === idDoItem);
    if (!item) {
      res.status(404).end();
      return;
    }
    res.type("application/pdf").send(item.pdf);
  });

  r.post("/enviar", exigirSessao, async (req, res) => {
    const corpo = req.body as {
      lote?: string;
      mes?: string;
      envios?: Array<{ id: string; email: string; tratamento?: string }>;
    };
    const lote = lotes.get(String(corpo.lote));
    if (!lote) {
      res.status(410).json({ erro: "lote expirado — suba o PDF de novo" });
      return;
    }
    if (!temGmail() && !temEnvioDeEmail()) {
      res.status(503).json({ erro: "envio de e-mail não configurado" });
      return;
    }

    const mes = String(corpo.mes || lote.mes);
    const resultados: Array<{ nome: string; email: string; ok: boolean; erro?: string }> = [];

    for (const envio of corpo.envios ?? []) {
      const item = lote.itens.find((i) => i.id === envio.id);
      if (!item) continue;
      const email = String(envio.email ?? "").trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        resultados.push({ nome: item.nome, email, ok: false, erro: "e-mail inválido" });
        continue;
      }

      const mensagem = {
        para: email,
        assunto: config()
          .HOLERITE_ASSUNTO.replace("{mes}", mes)
          .replace("{nome}", nomeBonito(item.nome)),
        corpo: corpoDoEmail(nomeBonito(item.nome), mes).replace(
          /^Prezad[ao]/,
          envio.tratamento === "Prezado" || envio.tratamento === "Prezada"
            ? envio.tratamento
            : tratamentoDe(item.nome),
        ),
        anexo: {
          nome: `Holerite ${mes.replace("/", "-")} - ${nomeBonito(item.nome)}.pdf`,
          conteudo: item.pdf,
        },
      };

      try {
        if (temGmail()) await enviarPeloGmail(mensagem);
        else await enviarEmail(mensagem);
        resultados.push({ nome: item.nome, email, ok: true });
      } catch (e) {
        resultados.push({
          nome: item.nome,
          email,
          ok: false,
          erro: e instanceof Error ? e.message : String(e),
        });
      }
    }

    console.log(
      `[rh] envio de ${mes}: ${resultados.filter((x) => x.ok).length} ok, ` +
        `${resultados.filter((x) => !x.ok).length} falha(s)`,
    );
    res.json({ resultados });
  });

  return r;
}

/** "ADRIANA DAYANE DE PAULA" -> "Adriana Dayane de Paula". */
function nomeBonito(nome: string): string {
  const minusculas = new Set(["de", "da", "do", "das", "dos", "e"]);
  return nome
    .toLocaleLowerCase("pt-BR")
    .split(/\s+/)
    .map((p, i) =>
      i > 0 && minusculas.has(p) ? p : p.charAt(0).toLocaleUpperCase("pt-BR") + p.slice(1),
    )
    .join(" ");
}

const PAGINA = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Holerites · L&F</title>
<style>
  :root { color-scheme: light; --tinta:#1a1a1a; --fraca:#6b6b6b; --linha:#e3e3e3; --ok:#0f7b3f; --ruim:#b3261e; --fundo:#faf9f7; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 16px 64px; font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; color:var(--tinta); background:var(--fundo); }
  main { max-width: 880px; margin: 0 auto; }
  h1 { font-size:22px; margin:0 0 4px; letter-spacing:.2px; }
  p.sub { color:var(--fraca); margin:0 0 24px; }
  section { background:#fff; border:1px solid var(--linha); border-radius:10px; padding:18px; margin-bottom:16px; }
  h2 { font-size:15px; margin:0 0 12px; }
  label { display:block; font-size:13px; color:var(--fraca); margin-bottom:6px; }
  input[type=password], input[type=text], input[type=email] { width:100%; padding:9px 10px; border:1px solid var(--linha); border-radius:7px; font:inherit; background:#fff; }
  input[type=file] { font:inherit; }
  button { font:inherit; padding:9px 16px; border-radius:7px; border:1px solid var(--tinta); background:var(--tinta); color:#fff; cursor:pointer; }
  button.secundario { background:#fff; color:var(--tinta); }
  button:disabled { opacity:.45; cursor:default; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th { text-align:left; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--fraca); border-bottom:1px solid var(--linha); padding:6px 6px; }
  td { border-bottom:1px solid var(--linha); padding:7px 6px; vertical-align:middle; }
  td input[type=email] { padding:5px 7px; font-size:13px; }
  tr.pendente td { background:#fff5f4; }
  .aviso { color:var(--ruim); font-size:13px; }
  .ok { color:var(--ok); }
  .rodape { display:flex; gap:12px; align-items:center; margin-top:16px; flex-wrap:wrap; }
  .oculto { display:none; }
  a { color:inherit; }
  @media (max-width:640px){ td,th{ padding:6px 3px; font-size:13px } }
</style>
</head>
<body>
<main>
  <h1>Holerites</h1>
  <p class="sub">Sobe o PDF da contabilidade, confere a lista e envia por e-mail. Nada sai sem você mandar.</p>

  <section id="login">
    <h2>Entrar</h2>
    <label for="senha">Senha</label>
    <input id="senha" type="password" autocomplete="current-password">
    <div class="rodape"><button id="btEntrar">Entrar</button><span id="erroLogin" class="aviso"></span></div>
  </section>

  <div id="app" class="oculto">
    <section>
      <h2>Cadastro de funcionários</h2>
      <p class="sub" id="estadoCadastro">—</p>
      <input id="csv" type="file" accept=".csv,text/csv">
      <div class="rodape"><button class="secundario" id="btCsv">Atualizar cadastro</button><span id="msgCsv" class="sub"></span></div>
    </section>

    <section>
      <h2>PDF dos holerites</h2>
      <input id="pdf" type="file" accept="application/pdf">
      <div class="rodape"><button id="btAnalisar">Separar por funcionário</button><span id="msgPdf" class="sub"></span></div>
    </section>

    <section id="resultado" class="oculto">
      <h2>Conferência</h2>
      <p class="sub" id="resumo"></p>
      <div style="max-width:220px"><label for="mes">Mês de referência</label><input id="mes" type="text"></div>
      <table id="tabela">
        <thead><tr><th></th><th>Funcionário</th><th>E-mail</th><th>Trat.</th><th>Pág.</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
      <div class="rodape">
        <button id="btEnviar">Enviar selecionados</button>
        <span id="msgEnvio" class="sub"></span>
      </div>
    </section>
  </div>
</main>
<script>
const $ = (s) => document.querySelector(s);
let lote = null;

async function api(rota, corpo, metodo) {
  const r = await fetch('/rh' + rota, {
    method: metodo || (corpo ? 'POST' : 'GET'),
    headers: corpo ? { 'content-type': 'application/json' } : undefined,
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || ('erro ' + r.status));
  return j;
}

$('#btEntrar').onclick = async () => {
  $('#erroLogin').textContent = '';
  try {
    await api('/entrar', { senha: $('#senha').value });
    $('#login').classList.add('oculto');
    $('#app').classList.remove('oculto');
    const e = await api('/estado');
    $('#estadoCadastro').textContent = e.cadastro
      ? e.cadastro + ' pessoa(s) no cadastro · envio por ' + (e.envio || 'nada configurado')
      : 'Nenhum cadastro ainda — suba o CSV com nome e e-mail.';
  } catch (e) { $('#erroLogin').textContent = e.message; }
};
$('#senha').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') $('#btEntrar').click(); });

$('#btCsv').onclick = async () => {
  const f = $('#csv').files[0];
  if (!f) return;
  $('#msgCsv').textContent = 'lendo…';
  try {
    const r = await api('/cadastro', { csv: await f.text() });
    $('#msgCsv').textContent = r.cadastro + ' pessoa(s) no cadastro';
    $('#estadoCadastro').textContent = r.cadastro + ' pessoa(s) no cadastro';
  } catch (e) { $('#msgCsv').textContent = e.message; }
};

const base64 = (f) => new Promise((ok, falha) => {
  const l = new FileReader();
  l.onload = () => ok(String(l.result));
  l.onerror = falha;
  l.readAsDataURL(f);
});

$('#btAnalisar').onclick = async () => {
  const f = $('#pdf').files[0];
  if (!f) return;
  $('#msgPdf').textContent = 'separando…';
  $('#btAnalisar').disabled = true;
  try {
    lote = await api('/analisar', { pdf: await base64(f), nome: f.name });
    desenhar();
    $('#msgPdf').textContent = '';
  } catch (e) { $('#msgPdf').textContent = e.message; }
  $('#btAnalisar').disabled = false;
};

function desenhar() {
  $('#resultado').classList.remove('oculto');
  $('#mes').value = mesBonito(lote.mes);
  const pend = [];
  if (lote.paginasSemNome.length) pend.push('páginas sem nome: ' + lote.paginasSemNome.join(', '));
  if (lote.paginasRepetidas.length) pend.push('páginas repetidas (contadas uma vez): ' + lote.paginasRepetidas.join(', '));
  $('#resumo').textContent = lote.itens.length + ' holerite(s) em ' + lote.totalDePaginas + ' página(s)'
    + (pend.length ? ' · ' + pend.join(' · ') : '');

  const corpo = $('#tabela tbody');
  corpo.innerHTML = '';
  for (const i of lote.itens) {
    const tr = document.createElement('tr');
    if (!i.email) tr.className = 'pendente';
    tr.innerHTML =
      '<td><input type="checkbox" data-id="' + i.id + '"' + (i.email ? ' checked' : '') + '></td>' +
      '<td>' + i.nome + '</td>' +
      '<td><input type="email" value="' + (i.email || '') + '" placeholder="sem cadastro" data-email="' + i.id + '"></td>' +
      '<td><select data-trat="' + i.id + '"><option' + (i.tratamento === 'Prezada' ? ' selected' : '') + '>Prezada</option><option' + (i.tratamento === 'Prezado' ? ' selected' : '') + '>Prezado</option></select></td>' +
      '<td>' + i.paginas.join(', ') + '</td>' +
      '<td><a href="/rh/pdf/' + lote.id + '/' + i.id + '" target="_blank">ver</a></td>';
    corpo.appendChild(tr);
  }
}

function mesBonito(m) {
  const [nome, ano] = m.split(' de ');
  if (!ano) return m;
  return nome.charAt(0).toUpperCase() + nome.slice(1) + '/' + ano;
}

$('#btEnviar').onclick = async () => {
  const envios = [...document.querySelectorAll('#tabela tbody input[type=checkbox]:checked')].map((c) => ({
    id: c.dataset.id,
    email: document.querySelector('[data-email="' + c.dataset.id + '"]').value.trim(),
    tratamento: document.querySelector('[data-trat="' + c.dataset.id + '"]').value,
  }));
  if (!envios.length) { $('#msgEnvio').textContent = 'nenhum selecionado'; return; }
  if (!confirm('Enviar ' + envios.length + ' holerite(s) de ' + $('#mes').value + '?')) return;
  $('#btEnviar').disabled = true;
  $('#msgEnvio').textContent = 'enviando…';
  try {
    const r = await api('/enviar', { lote: lote.id, mes: $('#mes').value, envios });
    const ok = r.resultados.filter((x) => x.ok).length;
    const falhas = r.resultados.filter((x) => !x.ok);
    $('#msgEnvio').innerHTML = '<span class="ok">' + ok + ' enviado(s)</span>'
      + (falhas.length ? ' · <span class="aviso">' + falhas.length + ' falha(s): ' + falhas.map((f) => f.nome + ' (' + f.erro + ')').join('; ') + '</span>' : '');
  } catch (e) { $('#msgEnvio').textContent = e.message; }
  $('#btEnviar').disabled = false;
};
</script>
</body>
</html>`;
