# convoz evals

Measures whether the convoz skill loads when Convoz work arrives (a watch line, a result to send, an owner decision), and stays off on near misses (a Slack draft, a code edit).
Run from `plugins/convoz` (each run is a paid model call):

    claude plugin eval . --runs 3 --ablation none --scaffold --trust-plugin --allow-tools Edit Write

Bash is not granted: that needs `bubblewrap` for the eval sandbox, so the suite checks what Claude chose, not that a `convoz` command ran.
