#!/bin/sh
# Entrypoint do braço.
#
# Não usa `xvfb-run` de propósito. Ele é um wrapper de shell que redireciona
# saída (o padrão de --error-file é /dev/null) e, quando falha, falha calado:
# o container subia, imprimia a primeira linha e ficava mudo, sem dizer se o
# problema era o Xvfb, o Node ou a imagem.
#
# Aqui cada etapa fala. Se parar, dá para ver exatamente onde.

set -e

echo "[entry] iniciando"
echo "[entry] node   $(node --version)"
echo "[entry] usuario $(id -u):$(id -g)"

# ── Xvfb ────────────────────────────────────────────────────────────
# Display virtual para rodar o Chrome em modo headful. Headless entrega uma
# classe inteira de sinais (UA HeadlessChrome, plugins vazios, WebGL irreal)
# que nenhum patch de JS cobre bem.
DISPLAY_NUM=99
export DISPLAY=":${DISPLAY_NUM}"

# O socket do X vive aqui; sem o diretório, o Xvfb morre sem explicar.
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix || true

if ! command -v Xvfb >/dev/null 2>&1; then
  echo "[entry] ERRO: binario Xvfb nao existe nesta imagem."
  echo "[entry] Adicione ao Dockerfile: RUN apt-get update && apt-get install -y xvfb"
  exit 12
fi

echo "[entry] subindo Xvfb em ${DISPLAY}"
Xvfb "${DISPLAY}" -screen 0 1440x900x24 -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!

# Espera o socket aparecer em vez de dormir um tempo fixo: em máquina lenta um
# sleep curto passa antes da hora, e num sleep longo se perde tempo à toa.
i=0
while [ ! -e "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; do
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then
    echo "[entry] ERRO: Xvfb não subiu em 10s. Log:"
    cat /tmp/xvfb.log || true
    exit 10
  fi
  # Se o processo morreu, não adianta esperar o socket.
  if ! kill -0 "$XVFB_PID" 2>/dev/null; then
    echo "[entry] ERRO: processo do Xvfb morreu. Log:"
    cat /tmp/xvfb.log || true
    exit 11
  fi
  sleep 0.1
done

echo "[entry] Xvfb pronto (pid ${XVFB_PID})"

# exec para o Node virar o PID 1: assim SIGTERM do Easypanel chega nele e o
# encerramento limpo do index.js funciona.
echo "[entry] entregando para o node"
exec node src/index.js
