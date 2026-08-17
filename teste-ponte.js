'use strict';

/**
 * Testes da Ponte Taobao — relay de código de verificação.
 * Roda sem tocar em API externa: só a lógica pura.
 *
 *   node teste-ponte.js
 */

// Estado em pasta DESCARTÁVEL, antes de qualquer require.
//
// Dois motivos, os dois aprendidos aqui: rodar este arquivo no servidor
// gravava por cima do data/ponte.json de verdade e apagaria a fila de quem
// está esperando código; e, mesmo local, o teste herdava a execução anterior —
// os contadores de limite não eram zerados pela limpeza abaixo, e o cenário do
// #ok começou a falhar com "já pediu vários códigos agora há pouco" só porque
// as execuções foram se somando no arquivo.
const os = require('os');
const pathMod = require('path');
const fsMod = require('fs');
const DATA_TESTE = pathMod.join(os.tmpdir(), 'phaze-teste-ponte');
fsMod.rmSync(DATA_TESTE, { recursive: true, force: true });
process.env.PONTE_DATA_DIR = DATA_TESTE;

process.env.PONTE_ATIVA = 'true';
process.env.PONTE_OPERADOR_NUMERO = '5541999999999';
process.env.PONTE_BRACO_KEY = 'teste';
process.env.PONTE_SELLER_CHAT_TITLE = '山王电玩';
// Fixado aqui de propósito: sem isto o teste leria o .env local e passaria a
// validar a configuração da máquina, não a lógica. dotenv não sobrescreve
// process.env já definido, então este valor vence.
process.env.PONTE_SELLER_TZ = 'America/Sao_Paulo';
process.env.PONTE_SELLER_JANELAS = '00:00-15:30,17:15-23:59';

// Estado limpo antes de qualquer coisa.
//
// O data/ponte.json sobrevive entre execuções — é o que faz um cliente no meio
// do fluxo atravessar um deploy. Só que num teste isso vira contaminação: a
// foto guardada na rodada anterior ainda está lá dentro dos 10 min de validade,
// e o "usuário sozinho pede a foto" passa a fechar o par com uma foto fantasma.
// Sender de mentira desde o começo.
//
// Cada alertar() tentava falar com a Evolution de VERDADE e esperava o timeout
// da rede — o arquivo inteiro levava 33s, quase tudo em conexão que nunca ia
// completar. Teste lento é teste que ninguém roda antes de dar deploy.
require('./src/sender').send = async () => {};

const estadoPonte = require('./src/ponte/estado');
Object.assign(estadoPonte.dados, {
  pendentes: {},
  testeOperador: null,
  atendimentos: [],
  tarefas: [],
  aprovacoes: [],
});

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

// ── Fluxo guiado: "preciso do código" ───────────────────────
// Este é o caminho do cliente que não sabe o que mandar. Sem ele, a mensagem
// cai no ignorar e — com BOT_AUTOREPLY=false — ninguém responde nada.
bloco('recepção — fluxo guiado passo a passo');
const CLI4 = '5541966661111';

r2 = recepcao.avaliar(CLI4, 'preciso do código', null);
t('"preciso do código" responde', r2.acao === 'responder', r2.acao);
t('pede a FOTO primeiro', /foto da tela do console/i.test(r2.mensagem || ''), r2.mensagem);
t('não pede o usuário ainda', !/login\/usu/i.test(r2.mensagem || ''));

r2 = recepcao.avaliar(CLI4, '', 'tela.jpg');
t('a foto agora tem resposta', r2.acao === 'responder', r2.acao);
t('e pede o login/usuário', /login\/usu/i.test(r2.mensagem || ''), r2.mensagem);
t('avisa para não mandar senha', /senha/i.test(r2.mensagem || ''));

r2 = recepcao.avaliar(CLI4, 'rsd32', null);
t('o usuário fecha o fluxo', r2.acao === 'pedir', r2.acao);
t('com o usuário certo', r2.usuario === 'rsd32', r2.usuario);
t('e a foto do passo 1', r2.imagem === 'tela.jpg', r2.imagem);

bloco('fluxo guiado — usuário sem dígito');
// Fora do fluxo "joaozinho" é ignorado; dentro dele o bot ACABOU de pedir o
// login, então a palavra solta é o login.
const CLI5 = '5541966662222';
recepcao.avaliar(CLI5, 'preciso do codigo', null);
recepcao.avaliar(CLI5, '', 'tela2.jpg');
r2 = recepcao.avaliar(CLI5, 'joaozinho', null);
t('aceita usuário só de letras dentro do fluxo', r2.acao === 'pedir', r2.acao);
t('usuário correto', r2.usuario === 'joaozinho', r2.usuario);
t('fora do fluxo continua ignorando',
  recepcao.avaliar('5541966663333', 'joaozinho', null).acao === 'ignorar');

bloco('fluxo guiado — não repete tutorial em rajada');
const CLI6 = '5541966664444';
t('1ª vez responde', recepcao.avaliar(CLI6, 'codigo', null).acao === 'responder');
t('2ª vez seguida cala', recepcao.avaliar(CLI6, 'codigo', null).acao === 'ignorar');
t('3ª vez seguida cala', recepcao.avaliar(CLI6, 'preciso do codigo', null).acao === 'ignorar');

bloco('fluxo guiado — corrige usuário inválido');
const CLI7 = '5541966667777';
recepcao.avaliar(CLI7, 'preciso do codigo', null);
recepcao.avaliar(CLI7, '', 'tela3.jpg');
r2 = recepcao.avaliar(CLI7, 'meu email', null);
t('explica o formato', r2.acao === 'responder', r2.acao);
t('dá exemplo de usuário', /rrrtsr223/.test(r2.mensagem || ''));

bloco('fluxo guiado — foto antes do pedido');
const CLI8 = '5541966666666';
t('foto solta segue calada', recepcao.avaliar(CLI8, '', 'tela4.jpg').acao === 'ignorar');
r2 = recepcao.avaliar(CLI8, 'preciso do codigo', null);
t('pedido depois pula direto pro usuário', /login\/usu/i.test(r2.mensagem || ''), r2.mensagem);

bloco('detecção de "quero o código"');
t('preciso do codigo', recepcao.pedeCodigo('preciso do codigo') === true);
t('com acento', recepcao.pedeCodigo('preciso do código') === true);
t('codigo pfv', recepcao.pedeCodigo('codigo pfv') === true);
t('cade o codigo', recepcao.pedeCodigo('cadê o código?') === true);
t('me manda o codigo de verificacao por favor',
  recepcao.pedeCodigo('me manda o codigo de verificacao por favor') === true);
t('o codigo nao chegou ainda, faz tempo que to esperando',
  recepcao.pedeCodigo('o codigo nao chegou ainda, faz tempo que to esperando') === true);
t('MAIÚSCULA', recepcao.pedeCodigo('PRECISO DO CÓDIGO') === true);

bloco('detecção — o que NÃO é pedido de código');
t('quanto custa o codigo do fifa',
  recepcao.pedeCodigo('quanto custa o codigo do fifa') === false);
t('quero comprar codigo de jogo',
  recepcao.pedeCodigo('quero comprar um codigo de jogo') === false);
t('codigo de barras', recepcao.pedeCodigo('codigo de barras da nota') === false);
t('cupom de desconto', recepcao.pedeCodigo('tem cupom de codigo de desconto?') === false);
t('oi', recepcao.pedeCodigo('oi') === false);
t('quero um jogo', recepcao.pedeCodigo('quero um jogo') === false);
t('call of duty não vira "cod"', recepcao.pedeCodigo('vcs tem call of duty?') === false);

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
// ── O cliente não pode saber de onde vem o código ───────────
// Para o cliente, quem gera é a Phaze. Uma palavra escapando numa mensagem
// automática entrega a origem — e mensagem automática é justamente a que
// ninguém relê antes de sair.
bloco('nada de "fornecedor"/"taobao" no que o cliente lê');
const PROIBIDO = /fornecedor|taobao|chin[êe]s|vendedor|parceiro/i;

// Vocabulário de automação. Vale para o cliente E para o operador: as duas
// coisas saem pelo mesmo número comercial.
//
// `autom[aá]tic\w*` e não `autom[aá]tico\b`: a versão antiga não casava
// "automaticamente", e foi assim que "Já estou pegando seu código
// automaticamente" ficou meses indo para o cliente. Sufixo aberto pega
// automático/automática/automaticamente/automatizado de uma vez.
//
// `\bbra[çc]o` com fronteira à esquerda para não acusar "abraço".
const AUTOMACAO =
  /\bbra[çc]o|rob[ôo]|\bbots?\b|autom[aá]tic\w*|automatiza\w*|\bscripts?\b|taobao|fornecedor/i;

// NUNCA dizer ao cliente que o pedido dele vai para outra pessoa.
//
// Não basta não escrever "fornecedor": "vou encaminhar", "vamos solicitar",
// "nosso parceiro vai responder" entregam a cadeia inteira sem usar nenhuma
// palavra da lista acima. Para o cliente quem gera o código é a Phaze, e é por
// isso que TODA mensagem fala em primeira pessoa — "eu pego", "te mando".
// Verbo de repasse é o sinal de que alguém escorregou para a terceira.
const REPASSE =
  /encaminh\w*|repass\w*|\bterceir\w*|nosso\s+parceir\w*|outra\s+empresa|solicit\w*\s+(ao|para|pro)\b|\bpedir?\s+(ao|para|pro)\s+\w*\s*(fornecedor|parceir\w*|loja|vendedor|eles)|mand\w*\s+(para|pro|pra|ao)\s+\w*\s*(fornecedor|parceir\w*|loja|vendedor|eles)/i;

const paraCliente = [];

paraCliente.push(janela.estado(emBRT('09:00')).avisoCliente);
paraCliente.push(janela.estado(emBRT('16:00')).avisoCliente);

const CLI9 = '5541911112222';
paraCliente.push(recepcao.avaliar(CLI9, 'preciso do codigo', null).mensagem);
paraCliente.push(recepcao.avaliar(CLI9, '', 'x.jpg').mensagem);
paraCliente.push(recepcao.avaliar(CLI9, 'nao lembro', null).mensagem);
paraCliente.push(recepcao.avaliar('5541911113333', 'rrtt9321', null).mensagem);

// O que o #enviar leva ao cliente quando a resposta não é código.
paraCliente.push(politica.paraCliente('看 https://item.taobao.com/i.htm 有货').texto);

paraCliente.forEach((m, i) => {
  t(`mensagem ${i + 1} não entrega a origem`, typeof m === 'string' && m.length > 0 && !PROIBIDO.test(m), m);
  // Faltava esta. As mensagens do cliente só eram conferidas contra a ORIGEM
  // (fornecedor/taobao), nunca contra vocabulário de robô — por isso
  // "automaticamente" passou batido mesmo com esta lista já montada aqui.
  t(`mensagem ${i + 1} sem vocabulário de robô`,
    typeof m === 'string' && !AUTOMACAO.test(m), (String(m).match(AUTOMACAO) || [''])[0] || 'limpo');
  t(`mensagem ${i + 1} não diz que repassa a alguém`,
    typeof m === 'string' && !REPASSE.test(m), (String(m).match(REPASSE) || [''])[0] || 'limpo');
  // Caractere chinês entrega a origem igual à palavra "fornecedor", e ainda
  // por cima o operador não consegue conferir o que não sabe ler.
  t(`mensagem ${i + 1} sem caractere chinês`, !politica.temCJK(m), m);
});

// A rede só vale se pegar o que ela existe para pegar. Sem estas, um regex
// quebrado passaria despercebido e o bloco acima viraria decoração — foi
// exatamente o que aconteceu com "automaticamente".
bloco('a própria rede pega o que deve');
for (const ruim of [
  'Já encaminhei seu pedido, aguarde',
  'Vou repassar para o fornecedor agora',
  'Nosso parceiro já está resolvendo',
  'Vamos solicitar ao fornecedor e te aviso',
  'Mandei para a loja, logo responde',
]) {
  t(`pega "${ruim.slice(0, 28)}"`, REPASSE.test(ruim) || PROIBIDO.test(ruim));
}
for (const bom of [
  'Já estou pegando seu código. Só um instante 👍',
  'Recebi tudo ✅ Já te retorno com o código 👍',
  'Anotei! Tem 2 pessoas na sua frente. Já já pego seu código e te mando 👍',
]) {
  t(`deixa passar "${bom.slice(0, 28)}"`, !REPASSE.test(bom) && !PROIBIDO.test(bom) && !AUTOMACAO.test(bom));
}

bloco('id fácil de copiar');
const { proximoId } = require('./src/ponte/estado');
const id1 = proximoId();
t('id é só número', /^\d+$/.test(id1), id1);
t('id tem no máximo 6 dígitos', id1.length <= 6, id1);
t('ids não repetem', proximoId() !== id1);

bloco('comandos do operador');
t('reconhece #fila do operador', operador.ehComando('5541999999999', '#fila') === true);
t('ignora #fila de estranho', operador.ehComando('5511888887777', '#fila') === false);
t('ignora conversa normal', operador.ehComando('5541999999999', 'oi tudo bem') === false);

// ── #teste: operador vira cliente ───────────────────────────
// Sem isto o operador não consegue testar o fluxo do próprio celular: a
// recepção ignora o número dele de propósito.
const OP = '5541999999999';

(async () => {
  bloco('#teste — operador vira cliente');
  t('#teste é comando', operador.ehComando(OP, '#teste') === true);
  t('operador ignorado antes',
    recepcao.avaliar(OP, 'preciso do codigo', null).acao === 'ignorar');

  let saida = await operador.executar('#teste');
  t('confirma que ligou', /teste ligado/i.test(saida), saida.split('\n')[0]);

  let r3 = recepcao.avaliar(OP, 'preciso do codigo', null);
  t('agora o operador é atendido', r3.acao === 'responder', r3.acao);
  t('e recebe o tutorial', /foto da tela do console/i.test(r3.mensagem || ''));

  saida = await operador.executar('#teste');
  t('segundo #teste desliga', /desligado/i.test(saida), saida);
  t('volta a ser ignorado',
    recepcao.avaliar(OP, 'preciso do codigo', null).acao === 'ignorar');

  // Rede de segurança: se o prazo vencer, volta a ser só operador sozinho.
  await operador.executar('#teste');
  require('./src/ponte/estado').dados.testeOperador = { ate: Date.now() - 1 };
  t('prazo vencido desliga sozinho',
    recepcao.avaliar(OP, 'preciso do codigo', null).acao === 'ignorar');

  // ── Vocabulário de automação no WhatsApp ──────────────────
  // Vale também para as mensagens do OPERADOR: elas saem pelo mesmo número
  // comercial, e é a conta inteira que corre risco, não só o 1-a-1 do cliente.
  bloco('nada de "braço"/"robô"/"bot" no WhatsApp');
  // Mesma AUTOMACAO usada nas mensagens do cliente, definida uma vez lá em
  // cima. Ter duas cópias do regex foi parte do problema: a de cima nem
  // existia, e reforçar uma não reforçava a outra.

  for (const cmd of ['#ajuda', '#fila', '#limpar', '#destravar', '#teste']) {
    const saida = String(await operador.executar(cmd));
    t(`${cmd} sem vocabulário de robô`, !AUTOMACAO.test(saida),
      (saida.match(AUTOMACAO) || [''])[0] || 'limpo');
  }
  await operador.executar('#teste'); // desliga o que o laço acima ligou

  // ── Marca da Phaze: onde deve, e só onde deve ──────────────
  bloco('marca da Phaze');
  const marca = require('./src/ponte/marca');

  const CLI_MARCA = '5541911119999';
  const primeira = recepcao.avaliar(CLI_MARCA, 'preciso do codigo', null).mensagem;
  t('a primeira mensagem do fluxo abre com a marca',
    primeira.startsWith(marca.CABECALHO), primeira.split('\n')[0]);

  // Repetir o cabeçalho a cada passo empurra a instrução para baixo, com o
  // cliente lendo com pressa no meio de uma compra.
  const intermediaria = recepcao.avaliar(CLI_MARCA, '', 'x.jpg').mensagem;
  t('a intermediária não repete o cabeçalho',
    !intermediaria.includes(marca.CABECALHO), intermediaria);

  // Operador lê no meio do atendimento: quer o dado, não a moldura. E cada
  // linha a mais é uma linha a mais para conferir no mesmo número comercial.
  for (const cmd of ['#fila', '#ajuda', '#limpar']) {
    const saida = String(await operador.executar(cmd));
    t(`${cmd} sem marca`,
      !saida.includes(marca.CABECALHO) && !saida.includes(marca.ASSINATURA));
  }

  // A marca não pode furar nenhuma das outras regras.
  const textoMarca = `${marca.CABECALHO} ${marca.ASSINATURA}`;
  // require inline: mais abaixo neste mesmo escopo há um `const politica`, e
  // usar o nome aqui cairia na temporal dead zone dele.
  t('a marca não entrega origem nem automação',
    !PROIBIDO.test(textoMarca) && !AUTOMACAO.test(textoMarca) &&
      !REPASSE.test(textoMarca) && !require('./src/ponte/politica').temCJK(textoMarca),
    textoMarca);

  // ── Erro técnico não vira mensagem de WhatsApp ─────────────
  // O texto abaixo é REAL: saiu pelo número comercial em 15/08 num alerta de
  // "Envio pela metade". Log de Playwright inteiro numa conversa de loja.
  bloco('stack trace nunca sai no WhatsApp');
  const politica = require('./src/ponte/politica');

  const STACK_REAL =
    'elementHandle.click: Timeout 30000ms exceeded.\n' +
    'Call log:\n' +
    '  - attempting click action\n' +
    '    2 × waiting for element to be visible, enabled and stable\n' +
    '      - element is not visible\n' +
    '  - retrying click action\n' +
    '    - waiting 500ms\n' +
    '    at Chat._acharNoFrame (/app/braco-web/src/chat.js:247:8)';

  const motivo = politica.motivoNeutro(STACK_REAL);
  t('o stack real vira frase curta', motivo === 'o passo passou do tempo e eu parei no meio', motivo);
  t('e não carrega nada do original',
    !/Timeout|click|waiting|chat\.js|30000ms/i.test(motivo), motivo);

  // Catálogo fechado: erro desconhecido cai no genérico em vez de vazar.
  const inedito = politica.motivoNeutro(new Error('WebSocket frame 0x8badf00d @ /srv/app.js:99'));
  t('erro inédito não vaza o texto', !/WebSocket|badf00d|app\.js/i.test(inedito), inedito);
  t('e ainda diz alguma coisa', inedito.length > 0);

  // Nenhuma frase do catálogo pode denunciar a origem nem a automação.
  for (const amostra of [STACK_REAL, 'net::ERR_CONNECTION_REFUSED', 'BloqueioDetectado',
    'SeletorNaoEncontrado: campoTexto', 'upload failed', '']) {
    const m = politica.motivoNeutro(amostra);
    t(`motivo limpo p/ "${String(amostra).slice(0, 22)}"`,
      !AUTOMACAO.test(m) && !PROIBIDO.test(m), m);
  }

  // A porta: limparAlerta é o que roda em TODO alerta, inclusive os do braço.
  const sujo = politica.limparAlerta(`⚠️ Envio pela metade\n\n${STACK_REAL}`);
  t('limparAlerta avisa que limpou', sujo.limpou === true);
  t('e o resultado não tem vocabulário de robô', !AUTOMACAO.test(sujo.texto), sujo.texto.slice(0, 40));
  t('nem caminho de arquivo .js', !/\.js\b/.test(sujo.texto), sujo.texto.slice(0, 60));
  // O dump inteiro tem que sumir, não só as palavras proibidas dele.
  t('nem sobra dump de log',
    !/Call log|attempting|waiting for|Timeout/i.test(sujo.texto), JSON.stringify(sujo.texto));

  // ── Nada em chinês no WhatsApp ─────────────────────────────
  // Vale para o alerta do operador também: sai pelo mesmo número comercial, e
  // ele decide entre #enviar e #nao lendo o português — o original em chinês
  // era ruído que ele não tinha como conferir.
  bloco('nada em chinês no WhatsApp');

  const comChines = politica.limparAlerta(
    '⚠️ *Resposta sem código*\n\n*Original:* 稍等 没有收到邮件\n*Tradução:* Só um momento.',
  );
  t('limparAlerta tira o chinês', !politica.temCJK(comChines.texto), comChines.texto);
  t('e mantém o português', /Só um momento/.test(comChines.texto), comChines.texto);

  // O que o #enviar leva ao cliente: se a tradução falhou num trecho, o
  // original não pode ir junto.
  const meioTraduzido = politica.paraCliente('Só um momento 稍等 有货');
  t('paraCliente tira o que não foi traduzido', !politica.temCJK(meioTraduzido.texto), meioTraduzido.texto);
  t('e marca para o operador revisar',
    meioTraduzido.flags.includes('sobrou_original') && meioTraduzido.precisaRevisao === true);

  // temCJK com regex /g alternaria true/false na mesma entrada se fosse
  // reaproveitado — a armadilha que o topo do politica.js documenta.
  t('temCJK é estável em chamadas seguidas',
    politica.temCJK('稍等') && politica.temCJK('稍等') && politica.temCJK('稍等'));
  t('e não acusa português', !politica.temCJK('Só um momento, já te retorno 👍'));

  const limpo = politica.limparAlerta('🛑 Envios congelados. Responde #liberar.');
  t('texto já limpo passa intacto', limpo.limpou === false, limpo.texto);

  // O alerta de bloqueio carrega a URL do VNC, que é COMO o captcha é
  // resolvido. Regex de limpeza que a engula deixa o operador sem o link
  // justamente na hora em que a fila está parada esperando por ele.
  // ── Envios congelados: o que cada lado recebe ──────────────
  // Caminho exercitado de verdade em 15/08: cliente pediu código com a fila
  // congelada de falhas anteriores.
  bloco('pedido com os envios congelados');
  const ponteMod = require('./src/ponte');
  const limitesMod = require('./src/ponte/limites');

  limitesMod.abrir('teste de congelamento', null);
  const congelado = await ponteMod.pedirCodigo('5541911114444', 'Fulano', 'usuario1', null);

  t('pedido não é aceito com a fila parada', congelado.aceito === false);
  // A regra é a mesma do resto: nada que o cliente leia pode admitir defeito.
  t('e o cliente não ouve falar de problema',
    !/problema|erro|falha|defeito|resolvendo|sistema/i.test(congelado.mensagem), congelado.mensagem);
  t('nem de robô ou da origem',
    !AUTOMACAO.test(congelado.mensagem) && !PROIBIDO.test(congelado.mensagem), congelado.mensagem);
  t('mas recebe algum retorno', congelado.mensagem.length > 0);
  limitesMod.fechar();
  // persistAgora e não persist: o teste sai por process.exit e o persist normal
  // tem debounce de 400ms — sem o flush, o disjuntor ficava ABERTO no
  // data/ponte.json e a execução seguinte começava congelada do nada.
  estadoPonte.persistAgora();

  // ── A promessa só sai depois do #ok ────────────────────────
  // No copiloto nada foi enviado enquanto a tarefa espera aprovação. Dizer
  // "já estou pegando seu código" ali é prometer uma ação que depende do
  // operador e que o #nao pode cancelar — o cliente ficava esperando algo
  // que nunca tinha começado.
  bloco('nada de promessa antes da aprovação');

  const CLI_OK = '5541911115555';
  const antesDoOk = await ponteMod.pedirCodigo(CLI_OK, 'Fulano', 'usuario9', null);
  const tarefaCriada = estadoPonte.dados.tarefas.find((x) => x.usuario === 'usuario9');

  if (tarefaCriada && tarefaCriada.estado === 'aguardando_aprovacao') {
    t('o pedido não promete que já está pegando',
      !/estou pegando|já pego|vou pegar/i.test(antesDoOk.mensagem), antesDoOk.mensagem);
    t('mas confirma que chegou', /recebi/i.test(antesDoOk.mensagem), antesDoOk.mensagem);
    // Cliente de verdade NUNCA pode ver comando de operador: ele não pode nem
    // saber que existe alguém aprovando do outro lado.
    t('e cliente de verdade não vê comando de operador',
      !/#\w+/.test(antesDoOk.mensagem), antesDoOk.mensagem);

    // O #ok manda a promessa ao cliente. Intercepta o sender para ver o que sai.
    const sender = require('./src/sender');
    const original = sender.send;
    const enviadas = [];
    sender.send = async (para, texto) => { enviadas.push({ para, texto }); };
    try {
      await operador.executar(`#ok ${tarefaCriada.id}`);
    } finally {
      sender.send = original;
    }

    const aoCliente = enviadas.find((e) => e.para === CLI_OK);
    t('o #ok avisa o cliente', Boolean(aoCliente), JSON.stringify(enviadas.map((e) => e.para)));
    if (aoCliente) {
      t('e aí sim promete', /pegando seu código|na fila/i.test(aoCliente.texto), aoCliente.texto);
      t('sem entregar a origem',
        !PROIBIDO.test(aoCliente.texto) && !AUTOMACAO.test(aoCliente.texto) && !REPASSE.test(aoCliente.texto),
        aoCliente.texto);
    }
  } else {
    t('cenário do #ok montado', false,
      `tarefa ficou como ${tarefaCriada ? tarefaCriada.estado : 'inexistente'}`);
  }

  // No #teste o operador É o cliente, e as duas mensagens caem no mesmo
  // número. Sem a instrução ali, "Recebi tudo" parece o fim do fluxo e o #ok
  // fica esquecido esperando um envio que nunca sai sozinho.
  // ── #teste tem que despausar o próprio número ──────────────
  // `paused` é o estado do falar_com_atendente, e handlers.js devolve SILÊNCIO
  // TOTAL nele. Com o número pausado, o #teste dizia "suas mensagens entram
  // como se fossem de um cliente" e nada acontecia — parecia bot quebrado.
  bloco('#teste despausa o número do operador');
  const storeMod = require('./src/store');
  storeMod.saveContact(OP, { paused: true });
  const respTeste = await operador.executar('#teste');
  t('o #teste tira o número da pausa', storeMod.getContact(OP)?.paused === false);
  t('e avisa que fez isso', /atendimento humano/i.test(respTeste), respTeste.slice(0, 60));
  await operador.executar('#teste'); // desliga

  // Fila limpa antes: o cenário acima deixou um atendimento na vez, e com
  // alguém sendo atendido o pedido novo entra na fila em vez de virar tarefa.
  estadoPonte.dados.atendimentos.length = 0;
  estadoPonte.dados.tarefas.length = 0;

  await operador.executar('#teste'); // liga
  const noTeste = await ponteMod.pedirCodigo(OP, 'Pedro', 'testeok1', null);
  const tarefaTeste = estadoPonte.dados.tarefas.find((x) => x.usuario === 'testeok1');
  if (tarefaTeste && tarefaTeste.estado === 'aguardando_aprovacao') {
    t('no modo teste a mensagem cobra o #ok', /#ok \d+/.test(noTeste.mensagem), noTeste.mensagem);
    t('e traz o id certo', noTeste.mensagem.includes(`#ok ${tarefaTeste.id}`), noTeste.mensagem);
    // "Recebi tudo ✅" na frente dá sensação de etapa concluída e o #ok fica
    // esperando. A pendência tem que ser a primeira coisa lida.
    t('e não abre com confirmação de recebido',
      !/^Recebi/i.test(noTeste.mensagem.trim()), noTeste.mensagem);
  } else {
    t('cenário do modo teste montado', false,
      `tarefa ficou como ${tarefaTeste ? tarefaTeste.estado : 'inexistente'}`);
  }
  await operador.executar('#teste'); // desliga

  const comVnc = politica.limparAlerta(
    '🛑 *Verificação na tela*\n\n1. Abre a tela: http://89.116.186.155:6080/vnc.html\n3. Responde *#liberar*',
  );
  t('URL do VNC sobrevive à limpeza', comVnc.texto.includes('89.116.186.155:6080/vnc.html'), comVnc.texto);

  console.log('\n' + (falhas ? falhas + ' FALHA(S)' : 'todos os testes passaram'));
  process.exit(falhas ? 1 : 0);
})();
