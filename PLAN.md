# Store display correctness, search parity, Big Picture polish

Depth tree, executed solo. The standing instruction in this session is not to
spawn subagents, so every leaf below is worked in-session, in order, against
one ledger (`GATES.md`). The tree is here for decomposition and for the
completion inventory, not for dispatch.

## Inventory of independently omittable outcomes

Taken from the request, before any splitting. Each line must end as a met gate
or an explicit handoff.

| # | Outcome | Gate |
|---|---------|------|
| 1 | A highlighted game in the desktop store is not sliced by its shelf | G1 |
| 2 | A highlighted game in the Big Picture store is not sliced by its shelf | G2 |
| 3 | Desktop search results are presented in the store's own language | G3 |
| 4 | Big Picture store search results are presented as store covers | G4 |
| 5 | Searching from the store searches the store, not the library | G5 |
| 6 | Big Picture store is improved beyond the bug fixes | G6, G7 |
| 7 | Nothing already working regresses | G8, G9 |

## Tree

```
root  Store display + search parity + Big Picture polish
│
├── 1  Clipping                                        (branch)
│   ├── 1.1  Desktop shelves                           (leaf)   G1
│   │   └── 1.1.1  reserve cross-axis room for the hover lift and its shadow
│   └── 1.2  Big Picture shelves                       (leaf)   G2
│       └── 1.2.1  reserve room for scale(1.075) + outline + bloom
│
├── 2  Search presents as the store                    (branch)
│   ├── 2.1  Desktop                                   (leaf)   G3
│   │   └── 2.1.1  results render as store cards, same chips and owned state
│   ├── 2.2  Big Picture                               (leaf)   G4
│   │   └── 2.2.1  results render as store covers, opening the store page
│   └── 2.3  Routing                                   (leaf)   G5
│       └── 2.3.1  the search button means "the store" from every store view
│
└── 3  Big Picture beyond the fixes                    (branch)
    ├── 3.1  Front page                                (leaf)   G6
    └── 3.2  Store page                                (leaf)   G7
```

## Notes on oracles

`dev/verify-store.mjs` parses the shipped CSS and JS and asserts structural
facts about them. It cannot see a rendered pixel, so every gate title below
says what is actually measured rather than claiming the visual outcome. Where
the visual outcome is the real subject, the gate is manual and carries the
reasoning as evidence.
