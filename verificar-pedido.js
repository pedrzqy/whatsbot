'use strict';

/**
 * Testa a ferramenta consultar_pedido contra a Nerix DE VERDADE.
 *
 *   node verificar-pedido.js <codigo-do-pedido> <email-da-compra>
 *
 * Existe porque teste-tools.js roda com dublês: ele prova a lógica (recusa sem
 * e-mail, não vaza dado de terceiro), mas não prova que os CAMPOS da resposta
 * real da Nerix são os que o formatador espera. Só um pedido de verdade mostra
 * isso — e mostra agora, no terminal, em vez de na conversa com um cliente.
 *
 * Não escreve nada e não muda estado da loja. A única chamada com efeito é o
 * check-payment, e ele só confirma pagamento que já existe.
 */

require('dotenv').config();

const [, , codigo, email] = process.argv;

if (!codigo || !email) {
  console.log('uso: node verificar-pedido.js <codigo-do-pedido> <email-da-compra>');
  console.log('');
  console.log('Pegue um pedido real no painel da Nerix — de preferência um JÁ PAGO');
  console.log('e um AGUARDANDO PAGAMENTO, para ver os dois caminhos.');
  process.exit(1);
}

// Sem estas, o config exige as chaves da ponte e o require falha antes de
// chegar na Nerix — que é o que a gente quer testar aqui.
process.env.PONTE_OPERADOR_NUMERO = process.env.PONTE_OPERADOR_NUMERO || '5541999999999';
process.env.PONTE_BRACO_KEY = process.env.PONTE_BRACO_KEY || 'verificacao';
process.env.PONTE_DATA_DIR =
  process.env.PONTE_DATA_DIR || require('path').join(require('os').tmpdir(), 'phaze-verificar');

const tools = require('./src/tools');
const config = require('./src/config');

(async () => {
  console.log(`Nerix : ${config.nerix.url}`);
  console.log(`chave : ${config.nerix.apiKey ? 'definida' : 'AUSENTE'}`);
  console.log(`pedido: ${codigo}`);
  console.log(`e-mail: ${email}`);
  console.log('');

  console.log('── o que a IA recebe ────────────────────────────');
  const certo = await tools.execute('consultar_pedido', { codigo, email });
  console.log(JSON.stringify(certo, null, 2));

  if (certo.erro) {
    console.log('');
    console.log('Deu erro. O que cada um significa:');
    console.log('  pedido_nao_encontrado -> código errado, ou de outra loja');
    console.log('  email_nao_confere     -> o e-mail não é o da compra');
    console.log('  falha_ao_consultar    -> chave inválida, rede, ou a API mudou (veja o log acima)');
    process.exit(1);
  }

  // O teste que importa de verdade: os campos vieram preenchidos, ou o
  // formatador está lendo nomes que a Nerix não usa?
  console.log('');
  console.log('── os campos casaram? ───────────────────────────');
  const conferir = [
    ['codigo', certo.codigo],
    ['status', certo.status],
    ['total', certo.total],
    ['pago', certo.pago],
    ['itens', certo.itens ? `${certo.itens.length} item(ns)` : null],
  ];
  for (const [nome, valor] of conferir) {
    const ok = valor !== null && valor !== undefined && valor !== 'desconhecido';
    console.log(`  ${ok ? 'ok  ' : 'VAZIO'} | ${nome}: ${JSON.stringify(valor)}`);
  }

  if (certo.status === 'desconhecido' && certo.status_bruto) {
    console.log('');
    console.log(`  ATENÇÃO: status "${certo.status_bruto}" não está no mapa de tradução.`);
    console.log('  Me manda esse valor que eu adiciono em src/tools.js (const STATUS).');
  }

  // A porta de segurança, contra a API real: e-mail de outra pessoa não pode
  // devolver dado nenhum do pedido.
  console.log('');
  console.log('── e com o e-mail errado? ───────────────────────');
  const intruso = await tools.execute('consultar_pedido', {
    codigo,
    email: 'nao-e-o-dono@exemplo-invalido.com',
  });
  const bloqueou = Boolean(intruso.erro);
  console.log(`  ${bloqueou ? 'ok  ' : 'FALHA'} | recusou: ${JSON.stringify(intruso)}`);
  if (!bloqueou) {
    console.log('');
    console.log('  PARE. A Nerix respondeu com dados usando um e-mail que não é o da compra.');
    console.log('  Isso é vazamento de dado de cliente — me avisa antes de subir isso.');
    process.exit(1);
  }

  console.log('');
  console.log('tudo certo.');
})().catch((err) => {
  console.error('falhou:', err.response?.data || err.message);
  process.exit(1);
});
