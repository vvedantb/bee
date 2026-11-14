import { IconBrandGithub, IconDownload } from "@tabler/icons-react";
import {
  Button,
  LandingFeatureCard,
  LandingFooter,
  LandingPageLayout,
  LandingSection,
  LandingSectionHeading,
  ProductHero,
  SiteHeader,
} from "@vvedantb/ui";
import { BeeWordmark } from "./BeeMark";
import { NotchDemo } from "./NotchDemo";
import { LandingCta, LandingReveal, LandingRevealItem } from "./landing-kit";
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
    <Button asChild size={size} className={size === "sm" ? "bee-download rounded-full" : "bee-download"}>
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
        <SiteHeader
          brand={<BeeWordmark />}
          homeHref="#top"
          homeLabel="Bee, back to top"
          links={navLinks}
          githubUrl={REPO_URL}
          githubLabel="Bee on GitHub"
          cta={<DownloadButton size="sm" />}
        />
      }
      hero={
        <ProductHero
          className="bee-hero"
          title={hero.title}
          tagline={hero.description}
          primaryCta={{ label: "Download", href: RELEASES_URL }}
          secondaryCta={{ label: "GitHub", href: REPO_URL }}
          visual={<NotchDemo />}
          visualLabel={hero.visualLabel}
          showProductOf={false}
        />
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
