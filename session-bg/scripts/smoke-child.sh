#!/bin/sh
printf "sbg smoke child\n"
for i in 1 2 3; do printf "line %s\n" "$i"; sleep 1; done
