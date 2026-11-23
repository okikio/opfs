# Independent CAR v1 fixture

`carv1-basic.car` and `carv1-basic.json` are copied unchanged from
[`ipld/ipld` commit `74e124966de8706b459d6ceb3044655dccb0f6a3`](https://github.com/ipld/ipld/tree/74e124966de8706b459d6ceb3044655dccb0f6a3/specs/transport/car/fixture/carv1-basic).
The original case identity is `carv1-basic`. The upstream dual-license notice is retained in `LICENSE`. No upstream
executable code or setup is run.

| File             | SHA-256                                                          |
| ---------------- | ---------------------------------------------------------------- |
| carv1-basic.car  | 543ff9c45bbcb5c439e8f8683115cf97fc5de6bb14175a749055304427c33c2e |
| carv1-basic.json | f47c67e0cf496e6c3af41b96b164f36b6ec750b57a9115f9d944a3fb886d303e |

The adapted test checks original root identity, eight sections, the first payload's offset/size, raw `cccc` block bytes,
and every block's SHA2-256 digest. It also corrupts/truncates copies to test refusal. It does not exercise DAG
traversal, UnixFS reconstruction, CAR v2, all multibases or all multihashes.
