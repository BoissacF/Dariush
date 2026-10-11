FROM alpine:3.19
RUN apk add --no-cache bash nano coreutils grep findutils

RUN printf '%s\n' \
    'umask 0000' \
    'export PS1="${PSEUDO:-eleve}@${CODE_CLASSE:-classe}:\w# "' \
    'export TERM=xterm-256color' \
    > /etc/bash.bashrc

RUN printf '%s\n' \
    'if [ -f /etc/bash.bashrc ]; then . /etc/bash.bashrc; fi' \
    > /etc/profile
