import Engine from "./core/Engine.js";

const config = {

    stream: {

        primary: "",

        backup: ""

    }

};

const engine = new Engine(config);

engine.start();