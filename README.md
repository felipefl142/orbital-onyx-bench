# Orbital Onyx Bench

Benchmark de combate de naves num campo gravitacional de N planetas. Cada modelo de linguagem escreve o programa que
controla a sua nave (motor, rotação e tiro). O app roda a física, faz os programas duelarem e ranqueia os modelos.

A pergunta que ele responde: **qual LLM escreve o melhor controlador para uma nave num campo gravitacional, contra
programas escritos por outros LLMs?**

Tudo roda no navegador. Não precisa de servidor.

## Começar

```sh
npm install
npm run dev          # abre em http://localhost:5173
```

Na aba **ARENA**, aperte espaço. Duas estratégias de referência (`turret` e `hunter`) duelam.

## Colocar um modelo para competir

1. Aba **MODEL LAB** → **provedores**: escolha uma predefinição ou preencha a base URL.
   - Servidor local (llama.cpp, llama-swap, vLLM, Ollama): tipo *OpenAI-compatível*, URL até `/v1`.
   - Nuvem: OpenAI, OpenRouter (OpenAI-compatível) ou Anthropic.
   - A chave fica só no IndexedDB deste navegador.
   - Se o servidor recusar pedidos do navegador (erro de CORS), marque **via proxy**. O `npm run dev` encaminha o
     pedido pelo próprio servidor de desenvolvimento.
2. **modelos**: adicione o id do modelo (o botão `/models` lista o que o servidor oferece).
3. **gerar estratégias**: marque os modelos e clique em gerar. Todos recebem o mesmo prompt, a mesma temperatura, o
   mesmo limite de tokens e o mesmo número de reparos.
   - O app extrai o bloco de código, compila e roda 10 s simulados contra `idle` e `turret`.
   - Se falhar, devolve o erro ao modelo e pede correção (até 3 vezes, ajustável). As rodadas usadas contam no ranking
     como "custo de geração".
4. Também dá para **colar** uma estratégia à mão.
5. Depois de um torneio, **v2 com feedback** manda ao modelo o próprio código e os próprios números (nunca o código dos
   rivais) e pede uma versão melhor.

## Torneio

Aba **TORNEIO**. Padrão: 1v1 round-robin, 20 seeds, mapas com 1, 3, 6 e 10 planetas, e cada lado joga de cada spawn.
Também há modo FFA (3 a 8 naves) e planetas em órbita.

O ranking mostra:

| Métrica | O que é |
|---|---|
| Elo | Bradley-Terry em escala Elo (400·log10), âncora `idle` = 0, IC 95 % por bootstrap (1000 reamostras por partida) |
| vitória | vitórias ÷ partidas (empate = meia vitória), IC de Wilson |
| sobrevivência | segundos vivo, em média |
| morte por planeta | % das partidas em que a nave bateu num planeta |
| precisão | acertos ÷ tiros |
| dano/fuel | dano causado ÷ combustível gasto |
| falhas/1k | (estouros de orçamento + exceções) por 1000 decisões |
| reparos, tokens | custo de geração do Model Lab |

Exporte em JSON (com ruleset, seeds, hash SHA-256 de cada estratégia e parâmetros de geração) ou CSV.

### Pela linha de comando

```sh
npm run bench -- --strategies ./strategies --seeds 20 --out results.json --csv results.csv
npm run bench -- --help
```

Cada `strategies/<nome>.js` é uma estratégia. As quatro de referência entram junto (tire com `--no-refs`). O JSON
pode ser importado na aba TORNEIO. `--save-replay ID:arquivo.json` grava uma partida como replay.

## Regras da simulação (ruleset `onyx-v1`)

- Passo fixo de 1/120 s, integrador leapfrog (velocity Verlet) com sub-passos perto dos planetas.
- Gravidade `a = G·M·d / (|d|² + ε²)^(3/2)`, ε = 0,5 × raio do planeta. Age em naves e projéteis.
- Arena circular de raio 2000. Fora dela: −10 HP/s. Encostar num planeta destrói a nave.
- Nave: 100 HP, 100 de combustível, empuxo 60/massa, rotação até 3 rad/s.
- Arma: projétil a 600 u/s mais a velocidade da nave, 10 de dano, 60 tiros, superaquece.
- Partida até 120 s. Vence o último vivo; no limite de tempo, quem tem mais HP.

Todos os números ficam no `RuleSet` (aba **REGRAS**). Editar cria um ruleset novo com hash novo; resultados só se
comparam dentro do mesmo hash.

## O contrato da estratégia

```js
export default function control(obs, mem) {
  return { thrust: 0, turn: 0, fire: false };   // thrust 0..1, turn -1..1
}
```

Chamada 20 vezes por segundo simulado. `obs` traz a própria nave, inimigos, projéteis, planetas, as regras, um
gerador aleatório com seed (`obs.rng`) e utilitários (`obs.lib.predict`, `leadTarget`, `gravityAt`…). O texto completo
que os modelos recebem está em [`src/llm/prompt.ts`](src/llm/prompt.ts).

Limites:

- **Orçamento de 200 000 operações por decisão**, contadas no código (cada volta de laço e cada chamada de função).
  É determinístico: o mesmo código estoura no mesmo ponto em qualquer máquina. Três estouros seguidos desligam a nave.
- Sem rede, `Date`, `performance`, `Math.random`, `eval`, `Function`, `import`.
- `mem` persiste durante a partida (até 64 KB).

## Determinismo

Mesma seed + mesmas estratégias = mesmo estado final, bit a bit.

- Aleatoriedade só por PRNG com seed (mulberry32).
- `Math.sin`, `Math.cos`, `Math.exp`… **não** dão o mesmo resultado em todos os motores JavaScript. Medido aqui: V8
  (Node) e SpiderMonkey (Firefox) diferiam em 1 ulp num `Math.cos` do gerador de mapas, e a partida inteira divergia.
  Por isso a simulação, a `obs.lib` e o `Math` entregue às estratégias usam versões próprias
  ([`src/sim/dmath.ts`](src/sim/dmath.ts), algoritmos do fdlibm) feitas só de `+ − × ÷` e `Math.sqrt`, que o
  IEEE-754 fixa. O operador `**` no código das estratégias é reescrito para essa mesma `pow`.
- Cada partida pode virar um replay (`ruleset + mapa + todas as ações`). Re-simular tem de chegar ao mesmo hash.

Verificado pelos testes: Node e Firefox chegam ao mesmo hash final em 44 partidas de referência (1v1, FFA, planetas
fixos e em órbita), e replays gravados no Node re-simulam igual no Firefox. Chrome e Safari não foram testados.

## Testes

```sh
npm test            # Vitest: física, determinismo, sandbox, estatística, ranking das referências
npm run e2e         # Playwright (Firefox): arena, replay, torneio, Model Lab com servidor LLM falso, Node × navegador
npm run build       # typecheck + build de produção
```

O teste do Model Lab usa um servidor OpenAI-compatível falso: a primeira resposta tem um bug, a segunda corrige.
Nenhum modelo real foi chamado nos testes.

## Números medidos

Nesta máquina (Linux, 20 threads lógicas), estratégias de referência:

| | |
|---|---|
| CLI (Node, 1 thread) | torneio de 960 partidas em 20 s (48 partidas/s) |
| Navegador (Firefox, 19 workers) | o mesmo torneio em 4,0 s, incluindo o bootstrap |
| Ranking das referências, 960 partidas | hunter 286 [247, 324] · turret 117 [90, 145] · orbiter 87 [58, 117] · idle 0 |

Node e Firefox deram o mesmo ranking, número por número.

## Estrutura

```
src/sim/        física, ruleset, mapas, PRNG, matemática determinística, replays (sem DOM; roda no Node)
src/sandbox/    instrumentação do código (orçamento de ops), controle, lockdown do realm
src/strategies/ referências: idle, orbiter, turret, hunter
src/bench/      agenda do torneio, métricas, Bradley-Terry, bootstrap, validação
src/llm/        provedores, prompt, extração do código, laço de reparo
src/workers/    Web Worker da simulação e clientes (arena, pool do torneio, validação)
src/store/      IndexedDB (Dexie)
src/ui/         React, tema, renderer do canvas
cli/            npm run bench
```

## Limites conhecidos

- O sandbox serve à justiça do benchmark, não à segurança: ele isola as estratégias da rede e entre si, mas não é
  barreira contra código hostil. Rode só código que você aceita executar.
- O orçamento conta laços e chamadas, não o trabalho dentro de funções nativas (`sort` de um array enorme, por
  exemplo). Um vigia de 30 s por partida derruba o worker se algo travar.
- Um `sort` com comparador inconsistente pode ordenar diferente em motores diferentes.
- A estética segue o skin padrão do Hermes Agent (dourados) sobre um marrom do skin `warm-lightmode`; não usa nome,
  símbolo nem logotipo do Hermes.

## Licença

MIT. Veja [LICENSE](LICENSE).
