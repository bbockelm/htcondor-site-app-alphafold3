// Something to count when the user has nothing to count.
//
// A public-domain passage, built into a File in the browser rather
// than shipped as an asset: it is a couple of kilobytes of source
// either way, and this way the bundle has no data files in it and no
// fetch to go wrong.

import type { FileSet } from '../types';

export const EXAMPLE_FILE = 'origin-of-species.txt';

/**
 * Charles Darwin, On the Origin of Species (1859), opening of the
 * Introduction and of Chapter 1. Public domain.
 *
 * Chosen because it is ordinary English prose: the counts come out
 * looking like a word count should, with "the" and "of" on top and a
 * long tail, which is the point of showing it.
 */
const PASSAGE = `When on board H.M.S. Beagle, as naturalist, I was much struck with
certain facts in the distribution of the inhabitants of South America,
and in the geological relations of the present to the past inhabitants
of that continent. These facts seemed to me to throw some light on the
origin of species -- that mystery of mysteries, as it has been called
by one of our greatest philosophers. On my return home, it occurred to
me, in 1837, that something might perhaps be made out on this question
by patiently accumulating and reflecting on all sorts of facts which
could possibly have any bearing on it.

After five years' work I allowed myself to speculate on the subject,
and drew up some short notes; these I enlarged in 1844 into a sketch of
the conclusions, which then seemed to me probable: from that period to
the present day I have steadily pursued the same object. I hope that I
may be excused for entering on these personal details, as I give them
to show that I have not been hasty in coming to a decision.

My work is now nearly finished; but as it will take me two or three
more years to complete it, and as my health is far from strong, I have
been urged to publish this Abstract. I have more especially been
induced to do this, as Mr. Wallace, who is now studying the natural
history of the Malay archipelago, has arrived at almost exactly the
same general conclusions that I have on the origin of species.

In considering the Origin of Species, it is quite conceivable that a
naturalist, reflecting on the mutual affinities of organic beings, on
their embryological relations, their geographical distribution,
geological succession, and other such facts, might come to the
conclusion that each species had not been independently created, but
had descended, like varieties, from other species.

Nevertheless, such a conclusion, even if well founded, would be
unsatisfactory, until it could be shown how the innumerable species
inhabiting this world have been modified, so as to acquire that
perfection of structure and coadaptation which most justly excites our
admiration. Naturalists continually refer to external conditions, such
as climate, food, etc., as the only possible cause of variation. In one
very limited sense, as we shall hereafter see, this may be true; but it
is preposterous to attribute to mere external conditions, the structure,
for instance, of the woodpecker, with its feet, tail, beak, and tongue,
so admirably adapted to catch insects under the bark of trees.

When we look to the individuals of the same variety or sub-variety of
our older cultivated plants and animals, one of the first points which
strikes us, is, that they generally differ much more from each other,
than do the individuals of any one species or variety in a state of
nature. When we reflect on the vast diversity of the plants and animals
which have been cultivated, and which have varied during all ages under
the most different climates and treatment, I think we are driven to
conclude that this greater variability is simply due to our domestic
productions having been raised under conditions of life not so uniform
as, and somewhat different from, those to which the parent species have
been exposed under nature.

No case is on record of a variable organism ceasing to vary under
cultivation. Our oldest cultivated plants, such as wheat, still yield
new varieties: our oldest domesticated animals are still capable of
rapid improvement or modification.
`;

export function buildExample(): FileSet {
  return {
    input: [new File([PASSAGE], EXAMPLE_FILE, { type: 'text/plain' })],
  };
}
