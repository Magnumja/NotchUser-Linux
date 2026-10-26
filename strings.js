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

export function tr(key, lang) {
    return STRINGS[key]?.[lang] ?? STRINGS[key]?.en ?? key;
}
