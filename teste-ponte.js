'use strict';

/**
 * Testes da Ponte Taobao — relay de código de verificação.
 * Roda sem tocar em API externa: só a lógica pura.
 *
 *   node teste-ponte.js
 */

process.env.PONTE_ATIVA = 'true';
process.env.PONTE_OPERADOR_NUMERO = '5541999999999';
process.env.PONTE_BRACO_KEY = 'teste';
process.env.PONTE_SELLER_CHAT_TITLE = '山王电玩';
// Fixado aqui de propósito: sem isto o teste leria o .env local e passaria a
// validar a configuração da máquina, não a lógica. dotenv não sobrescreve
// process.env já definido, então este valor vence.
process.env.PONTE_SELLER_TZ = 'America/Sao_Paulo';
process.env.PONTE_SELLER_JANELAS = '00:00-15:30,17:15-23:59';

const tools = require('./src/tools');
const codigo = require('./src/ponte/codigo');
const politica = require('./src/ponte/politica');
const janela = require('./src/ponte/janela');
const operador = require('./src/ponte/operador');

let falhas = 0;
const t = (nome, cond, extra = '') => {
  console.log((cond ? '  ok  ' : 'FALHA') + ' | ' + nome + (extra ? ' -> ' + extra : ''));
  if (!cond) falhas++;
};
const bloco = (nome) => console.log('\n--- ' + nome + ' ---');

// ── Ciclo de require ────────────────────────────────────────
// Se isto falhar, o function calling do bot INTEIRO morre, não só a ponte:
// tools chegaria vazio em ai.js por causa do require circular.
bloco('ciclo de require');
t('tools.definitions populado', Array.isArray(tools.definitions) && tools.definitions.length >= 3,
  'n=' + (tools.definitions || []).length);
t('ferramenta pedir_codigo_fornecedor existe',
  tools.definitions.some((d) => d.function.name === 'pedir_codigo_fornecedor'));
t('ferramentas originais intactas',
  ['buscar_produtos', 'falar_com_atendente'].every((n) =>
    tools.definitions.some((d) => d.function.name === n)));

// ── Classificar a resposta do fornecedor ────────────────────
// Falso positivo aqui entrega ao cliente um número que não é o código dele.
bloco('classificar resposta do fornecedor');
t('código de 6 dígitos', codigo.classificar('394860').tipo === 'codigo');
t('código com espaços', codigo.classificar('  543243  ').codigo === '543243');
t('código de 4 dígitos', codigo.classificar('1234').tipo === 'codigo');
t('código de 8 dígitos', codigo.classificar('12345678').tipo === 'codigo');
t('chinês vira problema', codigo.classificar('这个账号不存在').tipo === 'problema');
t('nº de pedido NÃO é código', codigo.classificar('3316356987038022191').tipo === 'problema');
t('preço NÃO é código', codigo.classificar('¥8.00').tipo === 'problema');
t('data NÃO é código', codigo.classificar('2026-08-14').tipo === 'problema');
t('horário NÃO é código', codigo.classificar('19:39').tipo === 'problema');
t('código com texto junto vira problema', codigo.classificar('你的code是394860').tipo === 'problema');
t('3 dígitos é curto demais', codigo.classificar('394').tipo === 'problema');
t('9 dígitos é longo demais', codigo.classificar('123456789').tipo === 'problema');

// ── Validar o usuário que o cliente mandou ──────────────────
bloco('validar usuário do cliente');
t('usuário real (rrrtsr223)', codigo.validarUsuario('rrrtsr223').valido === true);
t('usuário do print (ffgg2093)', codigo.validarUsuario('ffgg2093').valido === true);
t('20 chars aceito', codigo.validarUsuario('a'.repeat(20)).valido === true);
t('21 chars rejeitado', codigo.validarUsuario('a'.repeat(21)).valido === false);
t('frase inteira rejeitada', codigo.validarUsuario('meu usuario e joao').valido === false);
t('só dígitos rejeitado (parece código)', codigo.validarUsuario('394860').valido === false,
  codigo.validarUsuario('394860').motivo);
t('vazio rejeitado', codigo.validarUsuario('').valido === false);
t('e-mail rejeitado', codigo.validarUsuario('joao@gmail.com').valido === false);

bloco('extrair usuário de frase solta');
t('extrai de frase', codigo.extrairUsuario('meu usuario e rrrtsr223') === 'rrrtsr223');
t('extrai quando vem sozinho', codigo.extrairUsuario('rrrtsr223') === 'rrrtsr223');
t('ambíguo devolve null', codigo.extrairUsuario('rrrtsr223 ou ffgg2093') === null);
t('sem candidato devolve null', codigo.extrairUsuario('nao sei qual e') === null);

// ── Política (só o caminho de exceção, quando ele responde em chinês) ──
bloco('política na resposta em chinês');
let r = politica.paraCliente('这个手柄 39元 有现货');
t('esconde custo em CNY', !/39/.test(r.texto), r.texto);
t('marca preço_cny', r.flags.includes('preco_cny'));
t('exige revisão humana', r.precisaRevisao === true);

bloco('regex sem lastIndex vazando');
const a1 = politica.paraFornecedor('R$ 10').texto;
const a2 = politica.paraFornecedor('R$ 10').texto;
t('mesma entrada = mesma saída', a1 === a2, a1 + ' vs ' + a2);

// ── Janela do fornecedor (observada, em horário de Brasília) ──
// Config: 00:00-15:30 e 17:15-23:59. O único buraco é 15:30–17:15.
bloco('janela do fornecedor');
const emBRT = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  // BRT = UTC-3, então soma 3 para chegar no UTC do mesmo instante.
  return new Date(Date.UTC(2026, 7, 15, h + 3, m, 0));
};

t('09h00 BRT = online', janela.estado(emBRT('09:00')).aberta === true);
t('15h00 BRT = online (antes da pausa)', janela.estado(emBRT('15:00')).aberta === true);
t('16h00 BRT = OFFLINE (na pausa)', janela.estado(emBRT('16:00')).aberta === false);
t('17h00 BRT = OFFLINE (ainda na pausa)', janela.estado(emBRT('17:00')).aberta === false);
t('18h00 BRT = online (voltou)', janela.estado(emBRT('18:00')).aberta === true);
t('23h00 BRT = online', janela.estado(emBRT('23:00')).aberta === true);
t('03h00 BRT = online (madrugada)', janela.estado(emBRT('03:00')).aberta === true);

const naPausa = janela.estado(emBRT('16:00'));
t('espera até 17:15 ≈ 75 min', naPausa.esperaMinutos === 75, naPausa.esperaMinutos + ' min');
t('aviso cita o horário de volta', /17h15/.test(naPausa.avisoCliente), naPausa.avisoCliente);
t('dois intervalos configurados', janela.intervalos().length === 2);

// ── Recepção: detecção sem IA ───────────────────────────────
// Crítico: com BOT_AUTOREPLY=false o handlers retorna antes da IA, então este
// é o ÚNICO caminho pelo qual um pedido de cliente chega na ponte.
bloco('recepção — foto + usuário na mesma mensagem');
const recepcao = require('./src/ponte/recepcao');
const CLI = '5541988887777';

let r2 = recepcao.avaliar(CLI, 'rrrtsr223', 'foto1.jpg');
t('dispara com foto+usuário', r2.acao === 'pedir', r2.acao);
t('extrai o usuário certo', r2.usuario === 'rrrtsr223');
t('leva a foto junto', r2.imagem === 'foto1.jpg');

bloco('recepção — mensagens separadas (o caso comum)');
const CLI2 = '5541988886666';
r2 = recepcao.avaliar(CLI2, 'rrtt9321', null);
t('usuário sozinho: pede a foto', r2.acao === 'responder', r2.acao);
t('a resposta menciona print', /print/i.test(r2.mensagem || ''));
r2 = recepcao.avaliar(CLI2, '', 'foto2.jpg');
t('foto seguinte fecha o par', r2.acao === 'pedir', r2.acao);
t('lembrou o usuário', r2.usuario === 'rrtt9321');
t('e a foto nova', r2.imagem === 'foto2.jpg');
t('não repete o pedido', recepcao.avaliar(CLI2, '', 'foto3.jpg').acao === 'ignorar');

bloco('recepção — foto PRIMEIRO (o fluxo real)');
const CLI3 = '5541977775555';
r2 = recepcao.avaliar(CLI3, '', 'print.jpg');
t('foto sozinha não responde nada', r2.acao === 'ignorar', r2.acao);
r2 = recepcao.avaliar(CLI3, 'rrtt9321', null);
t('usuário depois fecha o par', r2.acao === 'pedir', r2.acao);
t('guardou a foto que veio antes', r2.imagem === 'print.jpg');

bloco('recepção — o que NÃO pode disparar');
t('palavra sem dígito não é usuário', recepcao.avaliar('5541966665555', 'rwad', null).acao === 'ignorar');
t('"oi" não dispara', recepcao.avaliar('5541977776666', 'oi', null).acao === 'ignorar');
t('"quero um jogo" não dispara',
  recepcao.avaliar('5541977776666', 'quero um jogo', null).acao === 'ignorar');
t('foto solta sem contexto não dispara',
  recepcao.avaliar('5541955554444', '', 'aleatoria.jpg').acao === 'ignorar');
t('palavra sem dígito não dispara',
  recepcao.avaliar('5541944443333', 'obrigado', null).acao === 'ignorar');
t('número do operador é ignorado',
  recepcao.avaliar('5541999999999', 'rrrtsr223', 'x.jpg').acao === 'ignorar');

// ── Comandos do operador ────────────────────────────────────
bloco('comandos do operador');
t('reconhece #fila do operador', operador.ehComando('5541999999999', '#fila') === true);
t('ignora #fila de estranho', operador.ehComando('5511888887777', '#fila') === false);
t('ignora conversa normal', operador.ehComando('5541999999999', 'oi tudo bem') === false);

console.log('\n' + (falhas ? falhas + ' FALHA(S)' : 'todos os ' + '' + 'testes passaram'));
process.exit(falhas ? 1 : 0);
