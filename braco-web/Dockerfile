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
COPY entrypoint.sh ./
# chmod aqui e não no repositório: o bit de execução não sobrevive a clone
# feito de Windows, então confiar no permissionamento do git quebraria o build.
RUN chmod +x entrypoint.sh

# O perfil do Chrome guarda cookies e os tokens de device da Taobao. Sem
# volume montado aqui, todo deploy vira "dispositivo novo" numa conta com
# 6 meses de histórico — que é o gatilho mais direto de verificação.
VOLUME ["/app/perfil-chrome"]

# Headful sob display virtual. Headless entrega uma classe inteira de sinais
# (UA HeadlessChrome, plugins vazios, WebGL irreal) que patch de JS não cobre
# bem. xvfb-run custa ~200MB de RAM e resolve na raiz.
#
# O entrypoint sobe o Xvfb à mão em vez de usar xvfb-run. O wrapper redireciona
# saída por padrão e falha calado — o container subia, imprimia uma linha e
# ficava mudo, sem dizer se o problema era o Xvfb, o Node ou a imagem.
ENTRYPOINT ["/app/entrypoint.sh"]
