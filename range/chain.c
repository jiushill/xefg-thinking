/*
 * chain.c — a deliberately LONG reasoning chain, built to test whether
 * disocclusion-gated verification pays off.
 *
 * One connection, four dependent values, every step fatal on error:
 *
 *   seed  : random per connection, printed
 *   A     : seed * K1                       (K1 must be read out of the binary)
 *   B     : rol7(A) ^ K2                    (rol vs ror is a trap; K2 in binary)
 *   C     : table[i1] ^ table[i2]           (table printed; index base is a trap)
 *   D     : rol7(B ^ C ^ K3)                (K3 in binary)
 *
 * Then a stack overflow must return into win() with rdi == D. A wrong D prints
 * "almost" and exits, so the whole chain has to be redone: ungrounded guesses
 * are expensive, which is exactly the property we want to measure.
 *
 * Build: gcc -static -no-pie -fno-stack-protector -O0 -o chain chain.c
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define K1 0x9e3779b9u
#define K2 0x5a5a5a5au
#define K3 0x13371337u

static unsigned int g_want;
static unsigned int table[16];

static unsigned int rol7(unsigned int x) { return (x << 7) | (x >> 25); }

__attribute__((noinline)) void win(unsigned int k) {
  if (k != g_want) {
    puts("almost.");
    fflush(stdout);
    _exit(1);
  }
  puts("congrats.");
  fflush(stdout);
  system("/bin/sh");
  _exit(0);
}

__attribute__((noinline)) void vuln(void) {
  char buf[64];
  printf("D> ");
  fflush(stdout);
  read(0, buf, 400);
  puts("bye.");
  fflush(stdout);
}

static unsigned int ask(const char *prompt) {
  char line[128];
  printf("%s: ", prompt);
  fflush(stdout);
  if (!fgets(line, sizeof line, stdin)) _exit(1);
  return (unsigned int)strtoul(line, NULL, 16);
}

int main(void) {
  unsigned int s, a, b, c, d;
  int i, i1, i2;

  setvbuf(stdin, NULL, _IONBF, 0);
  srand((unsigned)time(NULL) ^ (unsigned)getpid());
  s = ((unsigned int)rand() << 16) ^ (unsigned int)rand();

  printf("chain v1\nseed %08x\n", s);
  fflush(stdout);

  a = s * K1;
  if (ask("A") != a) { puts("x1"); return 1; }

  b = rol7(a) ^ K2;
  if (ask("B") != b) { puts("x2"); return 1; }

  for (i = 0; i < 16; i++) table[i] = rol7(s + (unsigned)i * 0x01000193u) ^ ((unsigned)i * 0x1234567u);
  i1 = rand() % 16;
  i2 = rand() % 16;
  printf("table:");
  for (i = 0; i < 16; i++) printf(" %08x", table[i]);
  printf("\nidx %d %d\n", i1, i2);
  fflush(stdout);

  c = table[i1] ^ table[i2];
  if (ask("C") != c) { puts("x3"); return 1; }

  d = rol7(b ^ c ^ K3);
  g_want = d;

  vuln();
  return 0;
}
