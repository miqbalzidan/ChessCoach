/**
 * What the engine thought of a move, in a word and a colour.
 *
 * The sheet's original icon set was chess's own annotation — `??`, `?`, `?!` — which
 * is compact, traditional, and completely opaque to anyone who has not already
 * learned it. That is a problem here specifically, because the person most likely to
 * be reading their own blunders is the person least likely to read annotation
 * fluently.
 *
 * So the glyph keeps its place and gains a word beside it. Colour carries the same
 * distinction a third time, which is deliberate redundancy rather than decoration:
 * scanning a list you catch the colour, reading a row you get the word, and neither
 * strands a reader who cannot tell these hues apart.
 */
import { GLYPH, VERDICT, type Classification } from '../types';

/** The class suffix per verdict. `best`, `excellent` and `good` share the quiet one. */
function toneOf(classification: Classification): string {
  if (classification === 'blunder') return 'verdict-blunder';
  if (classification === 'mistake') return 'verdict-mistake';
  if (classification === 'inaccuracy') return 'verdict-inaccuracy';
  if (classification === 'brilliant') return 'verdict-brilliant';
  return '';
}

export function Verdict({
  classification,
  className = '',
}: {
  classification: Classification;
  className?: string;
}) {
  const glyph = GLYPH[classification];
  return (
    <span className={`verdict ${toneOf(classification)} ${className}`.trim()}>
      {VERDICT[classification]}
      {/* The good verdicts have no glyph, and an empty span would still draw a gap. */}
      {glyph ? (
        <span className="verdict-glyph" aria-hidden="true">
          {glyph}
        </span>
      ) : null}
    </span>
  );
}
