# Telinha

Transmita sua tela, o áudio do PC, a câmera e o microfone para os amigos, direto de PC para PC, sem servidor no meio. Qualquer pessoa da sala pode compartilhar a tela, e tem chat com links e imagens.

## Baixar

Entre no site do Telinha (aba **Settings → Pages** mostra o link) ou vá em **Releases**, aqui ao lado, e baixe o arquivo que termina em `x64-setup.exe`.

Se o Windows avisar "O Windows protegeu o computador", clique em **Mais informações → Executar assim mesmo**.

## Como funciona

- Feito com [Tauri](https://tauri.app) (leve: usa o WebView2 do Windows).
- Os PCs se encontram por relays públicos do Nostr usando o código da sala. Depois disso, vídeo, áudio e chat vão direto e criptografados (WebRTC).
- O áudio do PC é capturado direto do Windows (WASAPI loopback, em Rust).

## Novas versões

A cada atualização enviada para a branch `main`, o GitHub gera o instalador sozinho (aba **Actions**). Para publicar como versão nova, aumente o `version` em `src-tauri/tauri.conf.json` (por exemplo, de `0.1.0` para `0.1.1`).

## Estrutura

```
index.html                 telas do app
src/main.js                sala, palco, chat
src/media.js               captura de tela, câmera, microfone e qualidade
src/room.js                salas P2P (códigos e conexão)
src/config.js              STUN/TURN e taxas de vídeo
src/styles.css             visual
public/pcm-player.js       toca o áudio do PC dentro da transmissão
src-tauri/src/audio.rs     captura do áudio do PC (WASAPI)
src-tauri/src/sharebar.rs  esconde a barra "está compartilhando sua tela"
src-tauri/src/links.rs     abre links do chat no navegador
docs/                      site de download (GitHub Pages)
.github/workflows/         gera o instalador automaticamente
```
