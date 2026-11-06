import { acceptAnswer, type ResumeAnswer, type ResumeResult } from '@jat/shared';

/**
 * The resume match the shared demo account shows: a made-up SDET's resume and a hand-written
 * answer in the shape Claude returns. The demo account cannot upload, so this is all it sees.
 * Keywords are marked found or missing by the same code as a real analysis.
 */
export const SAMPLE_RESUME = `Alex Rivera, Senior SDET. Boston, MA.
Eight years building test automation for web, API and mobile products. Playwright and Cypress suites
in TypeScript and JavaScript, REST API and contract testing, performance testing with k6, CI/CD on
GitHub Actions and Jenkins, Docker, AWS. Led a quality guild of six; coached teams on test strategy,
shift-left testing and Agile delivery. Cut release regressions by 40%. Appium for mobile regression.
SQL and PostgreSQL for test data. Mentoring, stakeholder management.`;

const kw = (group: 'hard_skill' | 'tool' | 'certification' | 'soft_skill', ...terms: string[]) =>
  terms.map((term) => ({ term, group }));

const title = (
  name: string,
  fit: 'strong' | 'good' | 'stretch',
  seniority: ResumeAnswer['titles'][number]['seniority'],
  reason: string,
  keywords: { term: string; group: 'hard_skill' | 'tool' | 'certification' | 'soft_skill' }[],
) => ({ title: name, fit, seniority, reason, keywords });

const CORE = [
  ...kw('tool', 'Playwright', 'Cypress', 'Selenium', 'Jenkins', 'GitHub Actions'),
  ...kw('hard_skill', 'TypeScript', 'test automation', 'API testing', 'CI/CD'),
  ...kw('soft_skill', 'stakeholder management'),
];

export const SAMPLE_ANSWER: ResumeAnswer = {
  summary:
    'A senior SDET with eight years of web, API and mobile automation and real leadership of a quality guild. Reads as ready for senior and lead automation roles; staff-level roles would want more architecture and scale evidence.',
  gaps: [
    'Add numbers to more roles (suite size, run time, defects caught before release).',
    'Name the test frameworks you designed, not only the tools you used.',
    'List any certifications (ISTQB, AWS) if you hold them.',
  ],
  warnings: [],
  titles: [
    title(
      'Senior SDET',
      'strong',
      'Senior',
      'Eight years of Playwright and Cypress automation in TypeScript.',
      [...CORE, ...kw('hard_skill', 'contract testing')],
    ),
    title(
      'Senior QA Automation Engineer',
      'strong',
      'Senior',
      'Built and owned automation suites that cut regressions by 40%.',
      [...CORE, ...kw('hard_skill', 'regression testing')],
    ),
    title(
      'Senior Software Engineer in Test',
      'strong',
      'Senior',
      'Writes production-quality TypeScript test code and CI pipelines.',
      [...CORE, ...kw('hard_skill', 'Node.js')],
    ),
    title(
      'QA Automation Lead',
      'strong',
      'Lead',
      'Led a quality guild of six and set test strategy.',
      [...CORE, ...kw('soft_skill', 'mentoring', 'test strategy')],
    ),
    title(
      'Test Automation Architect',
      'good',
      'Lead',
      'Designed suites across web, API and mobile.',
      [...CORE, ...kw('hard_skill', 'framework design', 'test architecture')],
    ),
    title(
      'Senior Quality Engineer',
      'strong',
      'Senior',
      'Shift-left practice and quality coaching across teams.',
      [...CORE, ...kw('hard_skill', 'shift-left testing')],
    ),
    title(
      'Staff Quality Engineer',
      'stretch',
      'Lead',
      'Guild leadership is a start; staff roles want org-wide scope.',
      [...CORE, ...kw('hard_skill', 'quality strategy', 'observability')],
    ),
    title(
      'Senior Automation Engineer',
      'strong',
      'Senior',
      'Automation across UI, API and performance layers.',
      [...CORE, ...kw('tool', 'k6')],
    ),
    title('API Test Engineer', 'good', 'Senior', 'REST API and contract testing experience.', [
      ...kw('hard_skill', 'API testing', 'REST', 'contract testing', 'OpenAPI'),
      ...kw('tool', 'Postman', 'Pact'),
    ]),
    title('Performance Test Engineer', 'good', 'Senior', 'Performance testing with k6.', [
      ...kw('tool', 'k6', 'JMeter', 'Grafana'),
      ...kw('hard_skill', 'load testing', 'performance testing'),
    ]),
    title('Mobile QA Automation Engineer', 'good', 'Senior', 'Appium for mobile regression.', [
      ...kw('tool', 'Appium', 'Detox', 'XCUITest', 'Espresso'),
      ...kw('hard_skill', 'mobile testing'),
    ]),
    title('QA Engineer', 'strong', 'Mid', 'Broad hands-on testing across products.', [
      ...kw('hard_skill', 'test cases', 'regression testing', 'SQL'),
      ...kw('tool', 'Jira', 'TestRail'),
    ]),
    title('QA Manager', 'stretch', 'Manager', 'Led a guild, but no direct reports yet.', [
      ...kw('soft_skill', 'people management', 'hiring', 'stakeholder management'),
      ...kw('hard_skill', 'QA process', 'metrics'),
    ]),
    title(
      'Software Development Engineer in Test II',
      'strong',
      'Mid',
      'Matches the SDET skill set at a large-company level.',
      CORE,
    ),
    title(
      'DevOps Test Engineer',
      'good',
      'Senior',
      'CI/CD on GitHub Actions and Jenkins with Docker.',
      [...kw('tool', 'Docker', 'Kubernetes', 'Terraform'), ...kw('hard_skill', 'CI/CD', 'AWS')],
    ),
    title(
      'Quality Assurance Lead',
      'good',
      'Lead',
      'Coached teams on test strategy and Agile delivery.',
      [
        ...kw('soft_skill', 'test strategy', 'Agile', 'mentoring'),
        ...kw('hard_skill', 'risk-based testing'),
      ],
    ),
    title(
      'Release Quality Engineer',
      'good',
      'Senior',
      'Owned release regressions and quality gates.',
      [
        ...kw('hard_skill', 'release management', 'quality gates', 'CI/CD'),
        ...kw('tool', 'GitHub Actions'),
      ],
    ),
    title(
      'Test Engineer, Payments',
      'good',
      'Senior',
      'Payments-adjacent product testing experience.',
      [
        ...kw('hard_skill', 'PCI DSS', 'API testing', 'test automation'),
        ...kw('tool', 'Playwright'),
      ],
    ),
    title(
      'Developer Productivity Engineer',
      'stretch',
      'Senior',
      'CI and tooling work points this way.',
      [
        ...kw('hard_skill', 'build systems', 'CI/CD', 'developer tooling'),
        ...kw('tool', 'Bazel', 'GitHub Actions'),
      ],
    ),
    title(
      'Site Reliability Engineer',
      'stretch',
      'Mid',
      'Performance and CI skills overlap; on-call and infrastructure are missing.',
      [
        ...kw('hard_skill', 'SLOs', 'incident response', 'observability'),
        ...kw('tool', 'Kubernetes', 'Prometheus', 'Terraform'),
      ],
    ),
  ],
};

export function sampleResult(): ResumeResult {
  const result = acceptAnswer(SAMPLE_ANSWER, SAMPLE_RESUME);
  if (!result) throw new Error('The demo sample analysis is invalid');
  return result;
}
