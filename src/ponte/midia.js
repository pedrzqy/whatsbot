'use strict';

/**
 * Guarda as fotos que o cliente manda, para o braço anexar no chat da Taobao.
 *
 * O braço roda em OUTRA máquina (a VPS com ADB para o cloud phone), então ele
 * não enxerga o disco do bot. Por isso a imagem é servida por URL: o braço
 * baixa, empurra para a galeria do celular e anexa.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..', '..', 'data', 'ponte-midia');

const EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/**
 * Grava um base64 vindo da Evolution e devolve o nome do arquivo.
 * @returns {Promise<string>} nome do arquivo (não o caminho — o braço monta a URL)
 */
async function salvar(base64, mimetype) {
  const ext = EXT[String(mimetype || '').toLowerCase()] || '.jpg';
  const nome = `${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}${ext}`;

  await fs.promises.mkdir(DIR, { recursive: true });
  // A Evolution às vezes devolve com o prefixo data:image/...;base64,
  const limpo = String(base64).replace(/^data:[^;]+;base64,/, '');
  await fs.promises.writeFile(path.join(DIR, nome), Buffer.from(limpo, 'base64'));

  podar().catch(() => {});
  return nome;
}

function caminho(nome) {
  // basename impede que "..\..\algo" saia da pasta de mídia.
  return path.join(DIR, path.basename(String(nome)));
}

function existe(nome) {
  try {
    return fs.existsSync(caminho(nome));
  } catch {
    return false;
  }
}

/** Apaga fotos com mais de 7 dias — o volume do Square Cloud não é infinito. */
async function podar(maxIdadeMs = 7 * 24 * 60 * 60 * 1000) {
  try {
    const arquivos = await fs.promises.readdir(DIR);
    const limite = Date.now() - maxIdadeMs;
    for (const a of arquivos) {
      const p = path.join(DIR, a);
      const st = await fs.promises.stat(p);
      if (st.mtimeMs < limite) await fs.promises.unlink(p);
    }
  } catch {
    /* pasta ainda não existe */
  }
}

module.exports = { salvar, caminho, existe, podar, DIR };
