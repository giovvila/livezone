/**
 * =====================================================
 * LIVEZONE Broadcast Engine
 * EngineConfig
 * =====================================================
 *
 * Gestisce la configurazione centralizzata del motore.
 */

export default class EngineConfig {

    constructor() {

        this.config = {};

    }

    /**
     * Carica la configurazione iniziale
     */
    load(config) {

        this.config = structuredClone(config);

    }

    /**
     * Restituisce tutta la configurazione
     */
    getAll() {

        return structuredClone(this.config);

    }

    /**
     * Restituisce un valore usando una path
     * Esempio:
     * get("stream.primary")
     */
    get(path) {

        if (!path) {
            return undefined;
        }

        return path
            .split(".")
            .reduce((obj, key) => obj?.[key], this.config);

    }

    /**
     * Modifica un valore
     * Esempio:
     * set("stream.primary", url)
     */
    set(path, value) {

        const keys = path.split(".");

        let obj = this.config;

        while (keys.length > 1) {

            const key = keys.shift();

            if (!obj[key]) {
                obj[key] = {};
            }

            obj = obj[key];

        }

        obj[keys[0]] = value;

    }

}