import Engine from './core/Engine.js';
new Engine().start();
import AdaptivePlayer from "./core/AdaptivePlayer.js";
const adaptivePlayer = new AdaptivePlayer(

    document.querySelector(".player-wrapper"),

    document.getElementById("video")

);

adaptivePlayer.start();