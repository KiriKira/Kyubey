import { handle } from "./relay.js";

export default {
  fetch(request, env) {
    return handle(request, env);
  },
};
