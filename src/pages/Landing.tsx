import { Link } from "../lib/router";

export function LandingPage() {
  return (
    <>
      <section className="hero">
        <p className="eyebrow">
          <img
            className="eyebrow-logo"
            src="/images/replay-logo.svg"
            alt="Replay QA"
          />
          <span>Replay QA</span>
          <span className="eyebrow-sep">+</span>
          <img
            className="eyebrow-logo"
            src="/images/fullstory_logomark.jpeg"
            alt="FullStory"
          />
          <span>FullStory</span>
          <span className="eyebrow-sep">+</span>
          <img
            className="eyebrow-logo"
            src="/images/obvious-logomark-source.jpg"
            alt="Obvious"
          />
          <span>Obvious</span>
        </p>
        <h1>
          Real user problems.
          <br />
          <span>Verified fixes.</span>
        </h1>
        <p className="intro">
          Self Healing connects what users experience to what your factory
          builds — session insights, QA, and fix verification through one API.
        </p>
        <div className="hero-actions">
          <Link to="/setup" className="btn btn--primary">
            Get started
          </Link>
          <Link to="/api" className="btn btn--secondary">
            API reference
          </Link>
        </div>
      </section>
      <section className="flow" aria-label="How self healing works">
        <article>
          <span className="step">01 / UNDERSTAND</span>
          <h2>See where users struggle</h2>
          <p>
            FullStory sessions surface friction, performance issues, and broken
            experiences.
          </p>
        </article>
        <article>
          <span className="step">02 / FIX</span>
          <h2>Give your factory the evidence</h2>
          <p>
            Replay QA supplies reproduction and root-cause evidence. Your coding
            agent writes the PR.
          </p>
        </article>
        <article>
          <span className="step">03 / VERIFY</span>
          <h2>Close the loop with QA</h2>
          <p>
            Validate the exact fix commit, review the PR, and follow behavior
            trends over time.
          </p>
        </article>
      </section>
    </>
  );
}
