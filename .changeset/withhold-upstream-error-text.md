---
"agility-bridge": patch
---

Agility's own error messages are no longer shown to the model: when Agility refuses a request, the tool error carries the
error code, our message and a hint naming a working next step, and Agility's text goes to the server log (`agility refused
the request`). The pre-release LLM eval showed models following an instruction planted in that text.
