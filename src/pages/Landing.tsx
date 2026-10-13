import { Link } from "../lib/router";

export function LandingPage() {
  return (
    <>
      <section className="hero">
        <p className="eyebrow">
          <span className="partner-pair">
            <img
              className="eyebrow-logo"
              src="/images/replay-logo.svg"
              alt=""
            />
            <span>Replay QA</span>
          </span>
          <span className="eyebrow-sep">+</span>
          <span className="partner-pair">
            <img
              className="eyebrow-logo"
              src="/images/fullstory_logomark.jpeg"
              alt=""
            />
            <span>FullStory</span>
          </span>
          <span className="eyebrow-sep">+</span>
          <span className="partner-pair">
            <img
              className="eyebrow-logo"
              src="/images/obvious-logomark-source.jpg"
              alt=""
            />
            <span>Obvious</span>
          </span>
        </p>
        <h1>
          Self-healing mode
          <br />
          <span>for your software factory.</span>
        </h1>
        <p className="intro">
          Turn problems in real user sessions into fix PRs your team can review,
          with Replay QA evidence to check the fix.
        </p>
        <p className="setup-hook">
          Paste one prompt into your Obvious agent. It handles setup and checks
          that real sessions are flowing.
        </p>
        <div className="hero-actions">
          <Link to="/setup" className="btn btn--primary">
            Set up in Obvious
          </Link>
          <Link to="/api" className="btn btn--secondary">
            View API reference
          </Link>
        </div>
        <p className="preview-note">
          Developer preview for teams using Obvious, with FullStory/Subtext
          session access. Your team controls review and merging.
        </p>
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
          <h2>Check the fix before it lands</h2>
          <p>
            Replay QA reruns the failing behaviour against the PR’s preview.
            Your team reviews the evidence and decides what to merge.
          </p>
        </article>
      </section>
      <section className="start-checklist" aria-labelledby="before-you-start">
        <div>
          <h2 id="before-you-start">Before you start</h2>
          <p>
            You’ll need an Obvious project, a Subtext API key with access to
            your FullStory sessions, and access to your app’s repository and
            deployment configuration.
          </p>
          <p>
            Provide credentials through Obvious’s secure input. Ongoing fix work
            needs an active factory loop and a usable PR preview for
            verification.
          </p>
        </div>
        <Link to="/setup" className="btn btn--primary">
          Set up in Obvious
        </Link>
      </section>
    </>
  );
}
