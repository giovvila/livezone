import { logoutOperator } from "../auth/OperatorSessionClient.js";

export default class OperatorSessionUI {
    constructor(button) {
        this.button = button;
        this.handleLogout = this.handleLogout.bind(this);
    }
    start() {
        if (!this.button) return false;
        this.button.addEventListener("click", this.handleLogout);
        return true;
    }
    destroy() { this.button?.removeEventListener("click", this.handleLogout); }
    async handleLogout() {
        this.button.disabled = true;
        try {
            if (!await logoutOperator()) this.button.disabled = false;
        }
        catch {
            this.button.disabled = false;
            this.button.textContent = "AUTH REQUIRED";
        }
    }
}
