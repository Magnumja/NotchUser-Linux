// Texts in English, Portuguese and Spanish, shared by the extension and its preferences.
import GLib from 'gi://GLib';

const STRINGS = {
    nothingPlaying: {en: 'Nothing playing', pt: 'Nada tocando', es: 'No suena nada'},
    hint: {
        en: 'Play something in Spotify, Firefox, Chrome…',
        pt: 'Toque algo no Spotify, Firefox, Chrome…',
        es: 'Reproduce algo en Spotify, Firefox, Chrome…',
    },
    settings: {en: 'Settings', pt: 'Ajustes', es: 'Ajustes'},
    language: {en: 'Language', pt: 'Idioma', es: 'Idioma'},
    langSystem: {en: 'System', pt: 'Sistema', es: 'Sistema'},
    behavior: {en: 'Behavior', pt: 'Comportamento', es: 'Comportamiento'},
    hoverOpen: {en: 'Open when hovering the pill', pt: 'Abrir ao passar o mouse na pílula', es: 'Abrir al pasar el ratón por la píldora'},
    showTitle: {en: 'Show the song title in the pill', pt: 'Mostrar o nome da música na pílula', es: 'Mostrar el nombre de la canción en la píldora'},
    bump: {en: 'Bounce when the song changes', pt: 'Dar um pulinho quando a música trocar', es: 'Dar un saltito al cambiar de canción'},
    shelf: {en: 'Shelf', pt: 'Prateleira', es: 'Estante'},
    openShelf: {en: 'Open the shelf', pt: 'Abrir a prateleira', es: 'Abrir el estante'},
    dropHere: {en: 'Drop here to keep it', pt: 'Solte aqui pra guardar', es: 'Suelta aquí para guardarlo'},
    releaseNow: {en: 'Drop it', pt: 'Pode soltar', es: 'Suéltalo'},
    clearShelf: {en: 'Clear shelf', pt: 'Limpar prateleira', es: 'Vaciar estante'},
    removeSelected: {en: 'Remove the selected', pt: 'Tirar os selecionados', es: 'Quitar los seleccionados'},
    alreadyOnShelf: {en: '%d already on the shelf', pt: '%d já na prateleira', es: '%d ya en el estante'},
    // Shelf item menu
    text: {en: 'Text', pt: 'Texto', es: 'Texto'},
    open: {en: 'Open', pt: 'Abrir', es: 'Abrir'},
    openN: {en: 'Open %d items', pt: 'Abrir %d itens', es: 'Abrir %d elementos'},
    copyText: {en: 'Copy text', pt: 'Copiar texto', es: 'Copiar texto'},
    showInFolder: {en: 'Show in folder', pt: 'Mostrar na pasta', es: 'Mostrar en la carpeta'},
    copy: {en: 'Copy', pt: 'Copiar', es: 'Copiar'},
    copyN: {en: 'Copy %d items', pt: 'Copiar %d itens', es: 'Copiar %d elementos'},
    selectAll: {en: 'Select all', pt: 'Selecionar tudo', es: 'Seleccionar todo'},
    deselect: {en: 'Deselect', pt: 'Desmarcar', es: 'Deseleccionar'},
    removeFromShelf: {en: 'Remove from shelf', pt: 'Tirar da prateleira', es: 'Quitar del estante'},
    removeN: {en: 'Remove %d from shelf', pt: 'Tirar %d da prateleira', es: 'Quitar %d del estante'},
    blurGlass: {en: 'Frosted glass blur (experimental)', pt: 'Desfoque de vidro (experimental)', es: 'Desenfoque de vidrio (experimental)'},
    reopenHint: {
        en: 'Language changes apply to this window the next time it opens.',
        pt: 'A troca de idioma vale para esta janela na próxima vez que ela abrir.',
        es: 'El cambio de idioma se aplica a esta ventana la próxima vez que se abra.',
    },
};

export const LANGUAGES = ['system', 'en', 'pt', 'es'];

/** The language actually used: the chosen one, or the system's if we have it. */
export function resolveLang(setting) {
    if (setting && setting !== 'system')
        return setting;
    for (const name of GLib.get_language_names()) {
        const code = name.slice(0, 2);
        if (['en', 'pt', 'es'].includes(code))
            return code;
    }
    return 'en';
}

/** `n` fills the `%d` of texts that carry a count ("Copy %d items"). */
export function tr(key, lang, n) {
    const s = STRINGS[key]?.[lang] ?? STRINGS[key]?.en ?? key;
    return n === undefined ? s : s.replace('%d', String(n));
}
