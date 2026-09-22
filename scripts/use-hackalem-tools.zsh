#!/bin/zsh
# Makes the project-local Node.js and GitHub CLI available in this terminal.
typeset _hackalem_script="${(%):-%N}"
export PATH="${_hackalem_script:A:h:h}/.tools/node/bin:${_hackalem_script:A:h:h}/.tools/gh/bin:$PATH"
unset _hackalem_script
