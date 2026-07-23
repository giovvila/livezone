import StateManager, { STATES } from "./core/StateManager.js";
import Engine from './core/Engine.js';
new Engine().start();
import AdaptivePlayer from "./core/AdaptivePlayer.js";
const adaptivePlayer = new AdaptivePlayer(

    document.querySelector(".player-wrapper"),

    document.getElementById("video")

);

adaptivePlayer.start();
StateManager.setState(STATES.CONNECTING);
StateManager.subscribe((current, previous)=>{

    console.log(

        "STATE:",

        previous,

        "→",

        current

    );

});