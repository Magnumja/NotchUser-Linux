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

- **Pílula no meio da barra de cima** com a capa e o nome da música, ao lado do relógio. Some quando nada está tocando.
- **Clique para abrir** um painel escuro e translúcido com capa, artista, barra de progresso (dá para arrastar) e controles.
- **Clique do meio** na pílula: play/pause sem abrir nada.
- **Funciona com qualquer player MPRIS**: Spotify, Firefox, Chrome/Chromium, VLC, Rhythmbox, Elisa…
- **Vários players ao mesmo tempo**: mostra o que começou a tocar por último; os ícones embaixo deixam trocar.
- **Português, English e Español**, seguindo o idioma do sistema.
- **Leve**: não roda nada em segundo plano; a posição da música só é consultada com o painel aberto.

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
