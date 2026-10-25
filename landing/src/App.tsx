import { IconBrandGithub, IconDownload } from "@tabler/icons-react";
import {
  Button,
  LandingFeatureCard,
  LandingFooter,
  LandingNavMenu,
  LandingPageLayout,
  LandingSection,
  LandingSectionHeading,
} from "@vvedantb/ui";
import { BeeWordmark } from "./BeeMark";
import { NotchDemo } from "./NotchDemo";
import { LandingCta, LandingHero, LandingNav, LandingReveal, LandingRevealItem } from "./landing-kit";
import { cta, footer, hero, how, more, navLinks, RELEASES_URL, REPO_URL } from "./content";

const github = { href: REPO_URL, label: "Bee on GitHub", icon: <IconBrandGithub size={18} /> };

function FeatureGrid({ features }: { features: typeof how.features }) {
  return (
    <LandingReveal className="mt-10 grid gap-3 sm:mt-12 sm:grid-cols-2">
      {features.map((feature) => (
        <LandingRevealItem key={feature.title}>
          <LandingFeatureCard {...feature} />
        </LandingRevealItem>
      ))}
    </LandingReveal>
  );
}

function DownloadButton({ size }: { size?: "sm" | "lg" }) {
  return (
    <Button asChild size={size} className="bee-download">
      <a href={RELEASES_URL}>
        <IconDownload size={16} />
        Download
      </a>
    </Button>
  );
}

export function App() {
  return (
    <LandingPageLayout
      nav={
        <LandingNav
          brand={<BeeWordmark />}
          homeLabel="Bee, back to top"
          links={navLinks}
          github={github}
          actions={<DownloadButton size="sm" />}
          menu={<LandingNavMenu links={navLinks} github={{ href: REPO_URL, icon: <IconBrandGithub size={16} /> }} />}
        />
      }
      hero={
        <>
          <LandingHero
            eyebrow={hero.eyebrow}
            title={hero.title}
            description={hero.description}
            capabilities={hero.capabilities}
            actions={
              <>
                <DownloadButton />
                <Button asChild variant="outline">
                  <a href={REPO_URL}>
                    <IconBrandGithub size={16} />
                    GitHub
                  </a>
                </Button>
              </>
            }
          />
          <NotchDemo />
        </>
      }
      footer={
        <LandingFooter
          brand={<BeeWordmark />}
          tagline={footer.tagline}
          links={footer.links}
          github={github}
        />
      }
    >
      <LandingSection id="how">
        <LandingSectionHeading eyebrow={how.eyebrow} heading={how.heading} />
        <FeatureGrid features={how.features} />
      </LandingSection>

      <LandingSection id="more" className="border-t border-separator">
        <LandingSectionHeading eyebrow={more.eyebrow} heading={more.heading} />
        <FeatureGrid features={more.features} />
      </LandingSection>

      <LandingCta
        title={cta.title}
        description={cta.description}
        action={
          <div className="flex flex-col items-stretch gap-2.5 sm:flex-row sm:items-center sm:gap-3">
            <DownloadButton size="lg" />
            <Button asChild size="lg" variant="outline">
              <a href={REPO_URL}>
                <IconBrandGithub size={16} />
                GitHub
              </a>
            </Button>
          </div>
        }
      />
    </LandingPageLayout>
  );
}
