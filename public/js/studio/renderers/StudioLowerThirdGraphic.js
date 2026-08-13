export default class StudioLowerThirdGraphic {

    static create(definition, payload) {
        if (!definition || !payload) {
            return null;
        }

        const lowerThird = document.createElement("div");
        const title = document.createElement("div");

        lowerThird.className = [
            "studio-graphic",
            "studio-lower-third",
            `studio-graphic--${definition.position}`
        ].join(" ");
        lowerThird.dataset.studioGraphicId = definition.id;

        title.className = "studio-lower-third__title";
        title.textContent = payload.title;
        lowerThird.appendChild(title);

        if (payload.subtitle) {
            const subtitle = document.createElement("div");

            subtitle.className = "studio-lower-third__subtitle";
            subtitle.textContent = payload.subtitle;
            lowerThird.appendChild(subtitle);
        }

        return lowerThird;
    }
}
