import { Context } from '@agentworkforce/relay';

export interface Plan {
  strategy: string;
  reasoning: string;
}

export interface DeveloperOutput {
  decisions: string[];
  implementationDetails: string;
}

export interface ReviewerOutput {
  deviations: string[];
  approved: boolean;
}

export const featureDevTemplate = {
  async run(requirements: string, initialContext?: Record<string, unknown>): Promise<{
    plan: Plan;
    development: DeveloperOutput;
    review: ReviewerOutput;
  }> {
    const ctx = new Context(initialContext);
    ctx.set('requirements', requirements);

    const plan = await this.planner(ctx);
    ctx.set('plan', plan);

    const development = await this.developer(ctx);
    ctx.set('development', development);

    const review = await this.reviewer(ctx);

    return { plan, development, review };
  },

  async planner(context: Context): Promise<Plan> {
    const requirements = context.get('requirements') as string;
    return {
      strategy: `Implement ${requirements}`,
      reasoning: 'Detailed reasoning based on requirements.'
    };
  },

  async developer(context: Context): Promise<DeveloperOutput> {
    const plan = context.get('plan') as Plan;
    return {
      decisions: [`Following strategy: ${plan.strategy}`],
      implementationDetails: 'Code changes made according to plan.'
    };
  },

  async reviewer(context: Context): Promise<ReviewerOutput> {
    const plan = context.get('plan') as Plan;
    const development = context.get('development') as DeveloperOutput;
    const deviations: string[] = [];
    if (!development.decisions.some(d => d.includes(plan.strategy))) {
      deviations.push('Implementation deviates from plan strategy');
    }
    return { deviations, approved: deviations.length === 0 };
  }
};
