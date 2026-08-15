# Imagem oficial do Playwright: já traz Node 20, os navegadores e TODAS as
# bibliotecas de sistema que o Chrome precisa (libnss, libatk, libgbm...).
# Montar isso à mão em cima de node:alpine dá umas 30 linhas de apt-get e
# quebra a cada atualização — não vale.
#
# A tag TEM que casar com a versão do playwright no package.json. Divergência
# faz o Playwright baixar o navegador em runtime, dentro do container, a cada
# start — lento e frágil.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Chrome de verdade, não o Chromium empacotado. O navegador.js usa
# channel: 'chrome' de propósito: Chromium tem diferenças de fingerprint
# (codecs, WebGL vendor) que detector de bot usa para separar um do outro.
RUN npx playwright install chrome

COPY src ./src
COPY seletores.json ./

# O perfil do Chrome guarda cookies e os tokens de device da Taobao. Sem
# volume montado aqui, todo deploy vira "dispositivo novo" numa conta com
# 6 meses de histórico — que é o gatilho mais direto de verificação.
VOLUME ["/app/perfil-chrome"]

# Headful sob display virtual. Headless entrega uma classe inteira de sinais
# (UA HeadlessChrome, plugins vazios, WebGL irreal) que patch de JS não cobre
# bem. xvfb-run custa ~200MB de RAM e resolve na raiz.
#
# O echo e o teste de xvfb-run vêm antes de propósito: sem eles, container que
# sobe e não imprime nada não diz se o problema é a imagem, o xvfb ou o Node.
# Com estas linhas, silêncio total passa a significar "nem o container subiu",
# que é um diagnóstico diferente.
CMD ["sh", "-c", "echo '[docker] container subiu'; command -v xvfb-run >/dev/null || echo '[docker] ERRO: xvfb-run ausente na imagem'; exec xvfb-run --auto-servernum --server-args='-screen 0 1440x900x24' node src/index.js"]
