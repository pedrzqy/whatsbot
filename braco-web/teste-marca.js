'use strict';

/**
 * Testa a marca d'água com os dois cenários que os dados reais expuseram:
 *
 *  1. JANELA DESLIZANTE — a lista mantém ~10 itens; mensagem nova entra, antiga
 *     sai. Marca por índice quebrava aqui.
 *  2. CÓDIGO REPETIDO — o mesmo número volta para outro cliente. Dedupe por
 *     conteúdo engolia o segundo.
 *
 * Não abre navegador: substitui _lerFornecedor pelo que o DOM devolveria.
 *
 *   node teste-marca.js
 */

const { Chat } = require('./src/chat');

let falhas = 0;
const t = (nome, cond, extra = '') => {
  console.log((cond ? '  ok  ' : 'FALHA') + ' | ' + nome + (extra ? ' -> ' + extra : ''));
  if (!cond) falhas++;
};

/** Monta a chave igual ao browser: nick|horário|conteúdo. */
const msg = (quando, texto, nick = 'newtype10') => ({
  chave: `${nick}|${quando}|${texto}`,
  texto,
  quando,
});

function chatFalso(mensagens) {
  const c = Object.create(Chat.prototype);
  c._lerFornecedor = async () => mensagens;
  // marca() e lerNovas() rolam a lista até o fim antes de ler. Sem navegador
  // não há o que rolar, e deixar o método real rodar aqui estoura em
  // this.frame — foi o que quebrou este teste sem ninguém perceber.
  c._irParaOFim = async () => {};
  return c;
}

(async () => {
  // ── Cenário 1: janela deslizante ───────────────────────────
  console.log('--- janela deslizante (dados reais de 14/08 e 15/08) ---');

  const antes = [
    msg('2026-08-14 18:03:18', '000843'),
    msg('2026-08-14 18:05:14', '529391'),
    msg('2026-08-14 19:39:37', '394860'),
  ];
  const marca = await chatFalso(antes).marca();
  t('marca guardou 3 chaves', marca.chaves.length === 3);
  t('e o corte é a mensagem mais recente', marca.ate === '2026-08-14 19:39:37', marca.ate);

  // Chega 你好 e a mais antiga sai da janela — total continua igual.
  const depois = [
    msg('2026-08-14 18:05:14', '529391'),
    msg('2026-08-14 19:39:37', '394860'),
    msg('2026-08-15 17:47:33', '你好'),
  ];
  const novas = await chatFalso(depois).lerNovas(marca);
  t('achou exatamente 1 nova', novas.length === 1, JSON.stringify(novas.map((m) => m.texto)));
  t('a nova é 你好', novas[0] && novas[0].texto === '你好');
  t('não reentregou 529391 nem 394860',
    !novas.some((m) => ['529391', '394860'].includes(m.texto)));

  // ── Cenário 2: código repetido ─────────────────────────────
  console.log('\n--- mesmo código para outro cliente ---');

  const m2 = await chatFalso([msg('2026-08-15 10:00:00', '394860')]).marca();
  const repetido = await chatFalso([
    msg('2026-08-15 10:00:00', '394860'), // o de antes
    msg('2026-08-15 11:30:00', '394860'), // MESMO código, outro horário
  ]).lerNovas(m2);
  t('código repetido é detectado', repetido.length === 1, JSON.stringify(repetido.map((m) => m.texto)));
  t('e vem com o horário novo', repetido[0] && repetido[0].quando === '2026-08-15 11:30:00');

  // ── Cenário 3: nada mudou ──────────────────────────────────
  console.log('\n--- sem resposta ainda ---');
  const m3 = await chatFalso(antes).marca();
  const nada = await chatFalso(antes).lerNovas(m3);
  t('não inventa mensagem', nada.length === 0);

  // ── Cenário 4: primeira execução, histórico cheio ──────────
  console.log('\n--- proteção contra ler o histórico ---');
  const historico = Array.from({ length: 50 }, (_, i) =>
    msg(`2026-06-${String((i % 28) + 1).padStart(2, '0')} 12:00:00`, String(100000 + i)),
  );
  const m4 = await chatFalso(historico).marca();
  const semNovas = await chatFalso(historico).lerNovas(m4);
  t('50 mensagens antigas não viram novidade', semNovas.length === 0);

  // ── Cenário 5: o corte por horário sozinho ─────────────────
  // Acima as antigas são barradas pelas CHAVES. Aqui não: a rolagem trouxe
  // para o DOM mensagem que não estava na marca, exatamente o caso que fez
  // conversa de outro dia chegar na fila como se fosse a resposta da vez.
  // Só o relógio segura isto.
  console.log('\n--- antiga que a rolagem trouxe de volta ---');

  const m5 = await chatFalso([msg('2026-08-15 14:00:00', '111111')]).marca();
  const rolou = await chatFalso([
    msg('2026-06-02 09:12:00', '777777'), // veio do histórico, fora da marca
    msg('2026-08-15 14:00:00', '111111'),
    msg('2026-08-15 14:20:10', '222222'), // essa sim é resposta
  ]).lerNovas(m5);
  t('antiga fora da marca não vira resposta', !rolou.some((m) => m.texto === '777777'),
    JSON.stringify(rolou.map((m) => m.texto)));
  t('e a resposta de verdade passa', rolou.length === 1 && rolou[0].texto === '222222');

  // Mensagem sem horário não é aceita: pode ser histórico, e código velho na
  // conta do cliente é pior do que não entregar nada.
  const semData = await chatFalso([
    msg('2026-08-15 14:00:00', '111111'),
    { chave: 'newtype10||333333', texto: '333333', quando: '' },
  ]).lerNovas(m5);
  t('mensagem sem horário é descartada', semData.length === 0,
    JSON.stringify(semData.map((m) => m.texto)));

  // ── Cenário 6: a leitura da marca falhou ───────────────────
  // O pior caso do sistema inteiro. Se a marca não pôde ser tirada e for
  // tratada como "chat vazio", não há chave nem corte de horário — e o
  // histórico inteiro vira resposta nova. O primeiro número de meses atrás
  // iria para o cliente da vez, ou seja, código de OUTRA pessoa na conta dele.
  console.log('\n--- marca que falhou não libera o histórico ---');

  const cQuebrado = Object.create(Chat.prototype);
  cQuebrado._irParaOFim = async () => {};
  cQuebrado._lerFornecedor = async () => { throw new Error('frame detached'); };

  const mRuim = await cQuebrado.marca();
  t('marca falha é marcada como não confiável', mRuim.confiavel === false);

  const comHistorico = await chatFalso(historico).lerNovas(mRuim);
  t('e o histórico NÃO vira resposta', comHistorico.length === 0,
    JSON.stringify(comHistorico.slice(0, 3).map((m) => m.texto)));

  // Marca boa continua marcada como confiável, senão nada mais passa.
  const mBoa = await chatFalso(antes).marca();
  t('marca normal é confiável', mBoa.confiavel === true);

  // Compatibilidade: marca legada (array puro) salva o atendimento em curso
  // quando o container reinicia no meio dele.
  const legada = await chatFalso(antes).lerNovas(antes.map((m) => m.chave));
  t('marca legada (array) ainda funciona', legada.length === 0);

  console.log('\n' + (falhas ? falhas + ' FALHA(S)' : 'todos passaram'));
  process.exit(falhas ? 1 : 0);
})();
