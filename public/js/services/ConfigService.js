export default class ConfigService {

    static config = null;

    static async load() {

        if (this.config) {
            return this.config;
        }

        try {

            const response = await fetch("config/config.json");

            if (!response.ok) {
                throw new Error("Impossibile leggere config.json");
            }

            this.config = await response.json();

            console.log("CONFIG LOADED", this.config);

            return this.config;

        } catch (error) {

            console.error("Errore ConfigService:", error);

            throw error;

        }

    }

    static get() {

        return this.config;

    }

}
