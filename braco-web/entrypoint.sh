#!/bin/bash
# Entrypoint do braço.
#
# bash e não sh de propósito: o teste de porta usa /dev/tcp, que é recurso do
# bash. No Ubuntu /bin/sh é o dash, e lá /dev/tcp não existe — o teste passaria
# despercebido como falso negativo.
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

# ── VNC (opcional) ──────────────────────────────────────────────────
# Só liga com VNC_PASSWORD definida. Sem senha NÃO sobe: um navegador logado
# na Taobao exposto na internet sem autenticação seria pior que o problema
# que ele resolve.
if [ -n "${VNC_PASSWORD}" ]; then
  # Checa os binários ANTES de tentar. Sem isto, um x11vnc ausente falha em
  # background, o script segue dizendo "VNC em :6080", e o sintoma aparece só
  # lá na frente como "Service is not reachable" no painel — apontando para o
  # lugar errado.
  faltando=""
  command -v x11vnc >/dev/null 2>&1 || faltando="${faltando} x11vnc"
  command -v websockify >/dev/null 2>&1 || faltando="${faltando} websockify"

  if [ -n "${faltando}" ]; then
    echo "[entry] ERRO: faltam na imagem:${faltando}"
    echo "[entry] O container foi buildado antes do commit que adiciona o VNC."
    echo "[entry] Faca um Deploy novo do servico braco."
  else
    echo "[entry] subindo VNC (tela remota para resolver verificação)"
    x11vnc -display "${DISPLAY}" -forever -shared -rfbport 5900 \
           -passwd "${VNC_PASSWORD}" -quiet >/tmp/x11vnc.log 2>&1 &
    # websockify serve o noVNC por HTTP: abre no navegador, sem instalar nada.
    # 0.0.0.0 e não localhost: o proxy do Easypanel vem de FORA do container,
    # e ligado só no loopback ele nunca alcançaria.
    websockify --web=/usr/share/novnc 0.0.0.0:6080 localhost:5900 \
               >/tmp/novnc.log 2>&1 &

    # Confirma que a porta abriu de verdade em vez de anunciar e torcer.
    j=0
    while [ "$j" -lt 50 ]; do
      if (echo > /dev/tcp/127.0.0.1/6080) 2>/dev/null; then
        echo "[entry] VNC pronto em :6080"
        break
      fi
      j=$((j + 1))
      sleep 0.2
    done
    if [ "$j" -ge 50 ]; then
      echo "[entry] AVISO: porta 6080 não abriu em 10s. Logs:"
      cat /tmp/x11vnc.log /tmp/novnc.log 2>/dev/null || true
    fi
  fi
else
  echo "[entry] VNC desligado (defina VNC_PASSWORD para habilitar)"
fi

# exec para o Node virar o PID 1: assim SIGTERM do Easypanel chega nele e o
# encerramento limpo do index.js funciona.
echo "[entry] entregando para o node"
exec node src/index.js
