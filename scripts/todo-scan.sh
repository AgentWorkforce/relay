#!/bin/bash
echo "=== Tech Debt Summary ==="
grep -rn "TODO\|FIXME\|HACK\|XXX" src/ packages/*/src/ --include="*.ts" | grep -v node_modules | grep -v dist
