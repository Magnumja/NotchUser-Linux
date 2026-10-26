<p align="center">
  <img src="https://raw.githubusercontent.com/Magnumja/NotchUser/main/Assets/logo.png" width="320" alt="NotchUser">
</p>

<p align="center">
  NotchUser para Linux: sua música numa pílula no meio da barra de cima do GNOME.<br>
  Versão para Ubuntu e outras distribuições com GNOME.
</p>

---

> A versão para Mac está em [Magnumja/NotchUser](https://github.com/Magnumja/NotchUser).

## O que ele faz

- **Pílula estilo notch no meio da barra de cima**, ao lado do relógio: capa, nome da música e **barrinhas animadas na cor do álbum**, como no Mac. Some quando nada está tocando.
- **Passe o mouse para abrir** (ou clique) um painel escuro e translúcido, **tingido com a cor da capa**: capa, artista, barra de progresso (dá para arrastar) e controles. Ele fecha sozinho quando o mouse sai.
- **"Pulinho"** na pílula quando a música troca.
- **Clique do meio** na pílula: play/pause sem abrir nada.
- **Funciona com qualquer player MPRIS**: Spotify, Firefox, Chrome/Chromium, VLC, Rhythmbox, Elisa…
- **Vários players ao mesmo tempo**: mostra o que começou a tocar por último; os ícones ao lado dos controles deixam trocar.
- **Ajustes** (engrenagem no painel, ou app Extensões): idioma (Sistema, Português, English, Español), abrir ao passar o mouse, mostrar o nome na pílula e o pulinho.
- **Leve**: a posição da música só é consultada com o painel aberto, e as barrinhas só animam enquanto toca.

Requisitos: GNOME 45 a 50 (Ubuntu 24.04 ou mais novo, Fedora 39+, …).

## Instalar

**Pelo .zip** (página de Releases):

```bash
gnome-extensions install --force notchuser@magnumja.github.io.zip
```

**Pelo código:**

```bash
git clone https://github.com/Magnumja/NotchUser-Linux.git
cd NotchUser-Linux
./install.sh
```

Depois **saia da sessão e entre de novo** (no Wayland o GNOME só carrega extensões novas assim) e ative:

```bash
gnome-extensions enable notchuser@magnumja.github.io
```

Também dá para ligar e desligar pelo app **Extensões** do Ubuntu.

## Se algo der errado

Os erros da extensão aparecem aqui:

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep -i notchuser
```

## Licença

[MIT](LICENSE).
