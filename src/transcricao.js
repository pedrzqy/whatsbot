'use strict';

/**
 * Áudio do cliente vira texto.
 *
 * Existe porque áudio era um buraco COMPLETO: o `server.js` extraía texto de
 * oito formatos de mensagem e `audioMessage` não era um deles. O cliente
 * mandava um áudio, `text` chegava vazio, e com a IA ligada o bot mandava para
 * o modelo a frase "(o cliente mandou uma foto sem escrever nada)" — a IA
 * respondia sobre uma foto que não existe, e o cliente ficava achando que o
 * atendimento tinha enlouquecido.
 *
 * E áudio não é caso de borda aqui: brasileiro manda áudio o tempo todo. É
 * provavelmente o caminho mais usado que nunca tinha sido testado.
 *
 * Usa a Groq, que serve o Whisper por uma API compatível com OpenAI — a MESMA
 * chave que já está paga e configurada na cascata. Nenhum provedor novo, nenhuma
 * conta nova: o áudio é rápido e barato lá (centavos por hora de áudio).
 */

const config = require('./config');

/** Tamanho máximo aceito. Acima disto não vale a pena nem tentar. */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Duração máxima em segundos.
 *
 * Áudio de cliente é curto — "oi, comprei ontem e não chegou". Um de cinco
 * minutos é quase sempre alguém contando a vida ou um encaminhamento, e
 * transcrever isso gera um muro de texto que piora a resposta do modelo em vez
 * de melhorar. O corte é declarado ao cliente, não silencioso.
 */
const MAX_SEGUNDOS = 180;

function chave() {
  return (
    process.env.TRANSCRICAO_API_KEY ||
    process.env.GROQ_FALLBACK_API_KEY ||
    process.env.FALLBACK_API_KEY ||
    process.env.GROQ_API_KEY ||
    ''
  );
}

function disponivel() {
  return Boolean(chave());
}

const URL_BASE = process.env.TRANSCRICAO_API_URL || 'https://api.groq.com/openai/v1';
const MODELO = process.env.TRANSCRICAO_MODELO || 'whisper-large-v3-turbo';

/**
 * @param {string} base64      áudio cru vindo da Evolution
 * @param {string} mimetype    ex.: 'audio/ogg; codecs=opus'
 * @param {number} [segundos]  duração informada pelo WhatsApp, se veio
 * @returns {Promise<{texto:string|null, motivo:string|null}>}
 *
 * NUNCA lança. Falha de transcrição não pode derrubar o atendimento — ela vira
 * `texto: null` com um motivo, e quem chama decide o que dizer ao cliente.
 * Áudio que não transcreve tem uma saída digna ("não consegui ouvir, escreve
 * aí?"); uma exceção não tem saída nenhuma.
 */
async function transcrever(base64, mimetype = 'audio/ogg', segundos = 0) {
  if (!disponivel()) return { texto: null, motivo: 'sem_chave' };
  if (segundos && segundos > MAX_SEGUNDOS) return { texto: null, motivo: 'longo_demais' };

  let bytes;
  try {
    bytes = Buffer.from(String(base64 || ''), 'base64');
  } catch {
    return { texto: null, motivo: 'audio_invalido' };
  }
  if (!bytes.length) return { texto: null, motivo: 'audio_vazio' };
  if (bytes.length > MAX_BYTES) return { texto: null, motivo: 'longo_demais' };

  // O nome do arquivo IMPORTA: o Whisper decide o decodificador pela extensão,
  // e o áudio do WhatsApp é sempre opus dentro de um contêiner ogg. Mandar
  // "arquivo.bin" faz a API recusar um áudio perfeitamente válido.
  const ext = /mp4|m4a|aac/i.test(mimetype) ? 'm4a' : /mpeg|mp3/i.test(mimetype) ? 'mp3' : 'ogg';

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mimetype.split(';')[0] }), `audio.${ext}`);
  form.append('model', MODELO);
  // Português fixo: a loja é brasileira e o cliente fala português. Deixar o
  // Whisper adivinhar faz ele às vezes transcrever "oi" como se fosse outro
  // idioma e devolver bobagem.
  form.append('language', 'pt');
  form.append('response_format', 'json');

  const controle = new AbortController();
  const prazo = setTimeout(() => controle.abort(), 20000);
  try {
    const resp = await fetch(`${URL_BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${chave()}` },
      body: form,
      signal: controle.signal,
    });

    if (!resp.ok) {
      // O corpo do erro fica no LOG do servidor, nunca perto do cliente: é
      // texto de terceiro e a regra do projeto é que erro técnico não vira
      // mensagem de WhatsApp.
      const corpo = await resp.text().catch(() => '');
      console.warn(`[transcricao] ${resp.status}: ${corpo.slice(0, 200)}`);
      return { texto: null, motivo: 'api_recusou' };
    }

    const json = await resp.json();
    const texto = String(json.text || '').trim();
    if (!texto) return { texto: null, motivo: 'nada_reconhecido' };

    console.log(`[transcricao] ${bytes.length} bytes → "${texto.slice(0, 60)}"`);
    return { texto, motivo: null };
  } catch (err) {
    console.warn('[transcricao] falhou:', err.name === 'AbortError' ? 'passou do prazo' : err.message);
    return { texto: null, motivo: 'falhou' };
  } finally {
    clearTimeout(prazo);
  }
}

/**
 * O que dizer ao cliente quando não deu para ouvir.
 *
 * Catálogo fechado, mesma ideia do `politica.motivoNeutro`: nenhuma dessas
 * frases admite defeito nosso nem entrega o motivo técnico. A saída é sempre a
 * mesma — pedir por escrito — porque é a única que resolve.
 */
function desculpa(motivo) {
  if (motivo === 'longo_demais') {
    return 'Recebi seu áudio, mas ele ficou comprido 😅 Me conta em poucas palavras por escrito?';
  }
  return 'Não consegui escutar direito seu áudio 🙏 Pode escrever aqui pra mim?';
}

module.exports = { transcrever, disponivel, desculpa, MAX_SEGUNDOS };
