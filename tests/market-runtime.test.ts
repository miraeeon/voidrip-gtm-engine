import { beforeEach, describe, expect, it } from 'vitest';
import type { HeyReachAdapter, HeyReachReadiness } from '../src/adapters/heyreach-execution.js';
import { all, nowIso, one, run } from '../src/db/db.js';
import {
  approveHeyReachImport,
  approveHeyReachLaunch,
  stageApprovedHeyReachImport,
} from '../src/market-runtime/activation.js';
import { saveMarketLearningProposal } from '../src/market-runtime/learning.js';
import { getMarketPerformance } from '../src/market-runtime/performance.js';
import { mapHeyReachConversation, mapHeyReachLeadResult } from '../src/market-runtime/provider-results.js';
import { freshEnv } from './helpers.js';

function seedReviewReady() {
  const at = nowIso();
  const candidate = run(
    `INSERT INTO candidates(name,linkedin_url,current_role,current_org,dedupe_key,state,created_at,updated_at)
     VALUES (?,?,?,?,?,'REVIEW_READY',?,?)`,
    'Ari Builder', 'https://linkedin.com/in/ari-builder/', 'Founder', 'World Studio', 'li:ari-builder', at, at,
  );
  const candidateId = Number(candidate.lastInsertRowid);
  const project = run(
    `INSERT INTO projects(candidate_id,name,url,kernel_primary,project_visibility,project_alignment,evidence_json,created_at,updated_at)
     VALUES (?,?,?,'MEDIA','VISIBLE','SELF_OWNED_PROFESSIONAL_PROJECT','[]',?,?)`,
    candidateId, 'World One', 'https://world.example', at, at,
  );
  const projectId = Number(project.lastInsertRowid);
  const boundary = run(
    `INSERT INTO boundary_qualifications(candidate_id,project_id,boundary_version,boundary_status,project_real,
      strategic_authority,ambition,intrinsic_complexity,professional_project_visibility,kernel_primary,
      failed_gates_json,missing_evidence_json,evidence_summary,confidence,reasoning,created_at)
     VALUES (?,?,'GTM_BOUNDARY_V1','PASS_OUTBOUND_V1','YES','INDIVIDUAL','HIGH','HIGH','ALIGNED','MEDIA','[]','[]',
      'All gates evidenced.','HIGH','All gates evidenced.',?)`,
    candidateId, projectId, at,
  );
  run(
    `INSERT INTO signal_events(candidate_id,project_id,signal_type,source,url,event_date,evidence,strength,mentionability,created_at)
     VALUES (?,?,'EXPLICIT_STRUCTURAL_NEED','founder-post','https://world.example/update','2026-09-30','Founder explicitly states that the project lacks a coherent cross-format structure.',5,'YES',?)`,
    candidateId, projectId, at,
  );
  const activation = run(
    `INSERT INTO activation_scores(candidate_id,project_id,boundary_qualification_id,intent_strength,freshness,
      priority_tier,route,angle,reasoning,created_at) VALUES (?,?,?,4,'RECENT','A','linkedin','world coherence','Current public signal.',?)`,
    candidateId, projectId, Number(boundary.lastInsertRowid), at,
  );
  const steps = [
    { type: 'linkedin_invite', delay_days: 0, note: 'World One caught my eye.' },
    { type: 'linkedin_message', delay_days: 1, message: 'Ari, I came across World One on LinkedIn and the scale caught my attention. Worth comparing notes?' },
    { type: 'linkedin_message', delay_days: 3, message: 'Ari, That expansion made me wonder: how do you keep the whole world coherent?' },
  ];
  const sequence = run(
    `INSERT INTO candidate_sequences(candidate_id,project_id,activation_score_id,version,status,route,angle,hook_type,
      steps_json,lint_json,playbook_version,review_status,created_at)
     VALUES (?,?,?,1,'final','linkedin','world coherence','project_signal',?,'{}',1,'pending',?)`,
    candidateId, projectId, Number(activation.lastInsertRowid), JSON.stringify(steps), at,
  );
  return { candidateId, projectId, sequenceId: Number(sequence.lastInsertRowid) };
}

function readiness(leadCount = 0): HeyReachReadiness {
  return {
    provider: 'heyreach',
    campaign: {
      id: 623081, name: 'VOIDRIP', status: 'DRAFT', linkedInUserListId: 71,
      campaignAccountIds: [11], progressStats: { totalUsersInProgress: 0 },
    },
    leadCount: 0,
    inert: true,
    leadList: { id: 71, name: 'Approved prospects', count: leadCount },
    availableAccounts: [{ id: 11, name: 'Jen Veyre', authValid: true }],
    assignedAccounts: [{ id: 11, name: 'Jen Veyre', authValid: true }],
    sequence: {
      nodeCount: 6,
      requiredVariables: ['FIRST_NAME', 'platform', 'specific_observation', 'specific_observation_2', 'specific_project'],
    },
    blockers: [],
    readyForImportApproval: true,
    readyForLaunchApproval: leadCount > 0,
  };
}

describe('controlled HeyReach activation', () => {
  beforeEach(() => freshEnv({ HEYREACH_CAMPAIGN_ID: 623081, GTM_DAILY_SEQUENCES: 1, GTM_DAILY_PUSH_LIMIT: 20 }));

  it('records explicit import approval locally, then stages only through the separate list-import call', async () => {
    const seeded = seedReviewReady();
    expect(approveHeyReachImport([seeded.candidateId])).toMatchObject({ approved: 1, provider_action: 'NONE' });
    expect(one<any>('SELECT status,staged_at FROM provider_activations')).toMatchObject({ status: 'IMPORT_APPROVED', staged_at: null });

    const calls: string[] = [];
    const execution = {
      inspectReadiness: async () => readiness(0),
      stageApprovedLeads: async (leads: any[], allowImport: boolean) => {
        calls.push(`stage:${allowImport}:${leads[0].customUserFields.length}`);
        return { addedLeadsCount: 1 };
      },
      listStagedLeads: async () => ({
        totalCount: 1,
        items: [{ profileUrl: 'https://www.linkedin.com/in/ari-builder' }],
      }),
    } as unknown as HeyReachAdapter;
    await expect(stageApprovedHeyReachImport({ execution })).resolves.toMatchObject({ staged: 1, campaign_started: false });
    expect(calls).toEqual(['stage:true:4']);
    expect(one<any>('SELECT status,provider_list_id,launched_at FROM provider_activations')).toMatchObject({
      status: 'STAGED', provider_list_id: '71', launched_at: null,
    });
  });

  it('keeps launch as a second local approval with no provider action', async () => {
    const seeded = seedReviewReady();
    approveHeyReachImport([seeded.candidateId]);
    run(`UPDATE provider_activations SET status='STAGED',staged_at=?,provider_list_id='71'`, nowIso());
    const execution = { inspectReadiness: async () => readiness(1) } as unknown as HeyReachAdapter;
    await expect(approveHeyReachLaunch([seeded.candidateId], { execution })).resolves.toMatchObject({
      approved: 1, provider_action: 'NONE',
    });
    expect(one<any>('SELECT status,launched_at FROM provider_activations')).toMatchObject({ status: 'LAUNCH_APPROVED', launched_at: null });
  });
});

describe('results and proposal-only learning', () => {
  beforeEach(() => freshEnv({ HEYREACH_CAMPAIGN_ID: 623081 }));

  it('normalizes provider events and numeric conversation ids', () => {
    expect(mapHeyReachLeadResult(623081, {
      profileUrl: 'https://linkedin.com/in/ari-builder',
      leadConnectionStatus: 'ConnectionAccepted', senderStatus: 'message_replied', autoTag: 'Interested',
    }).map((event) => event.type)).toEqual(expect.arrayContaining(['CONNECTION_ACCEPTED', 'REPLY_RECEIVED', 'POSITIVE_REPLY']));
    expect(mapHeyReachConversation({
      id: 987, profileUrl: 'https://linkedin.com/in/ari-builder', lastMessageFrom: 'lead', lastMessage: 'Yes, tell me more.',
    })).toMatchObject({ conversationId: '987', fromLead: true, text: 'Yes, tell me more.' });
  });

  it('refuses invented learning and keeps low-sample proposals explicitly low confidence', () => {
    expect(() => saveMarketLearningProposal({
      insights: [{ finding: 'Media founders reply more often.', evidence: 'No evidence yet.', confidence: 'low', action: 'Wait.' }],
    })).toThrow(/no real outcomes/);

    const seeded = seedReviewReady();
    approveHeyReachImport([seeded.candidateId]);
    run(`UPDATE provider_activations SET status='ACTIVE',launched_at=?`, nowIso());
    const activationId = one<{ id: number }>('SELECT id FROM provider_activations')!.id;
    for (const eventType of ['MESSAGE_SENT', 'REPLY_RECEIVED', 'POSITIVE_REPLY']) {
      run(
        `INSERT INTO market_outcome_events(activation_id,candidate_id,project_id,event_type,event_at,source,
          provider_event_key,is_simulated,created_at) VALUES (?,?,?,?,?,'heyreach',?,0,?)`,
        activationId, seeded.candidateId, seeded.projectId, eventType, nowIso(), `test:${eventType}`, nowIso(),
      );
    }
    expect(getMarketPerformance({ includeSimulated: false }).totals).toMatchObject({ contacted: 1, replied: 1, positive: 1 });
    expect(() => saveMarketLearningProposal({
      insights: [{ finding: 'The observed reply was positive.', evidence: 'One real activation replied.', confidence: 'medium', action: 'Change the playbook.' }],
    })).toThrow(/confidence=low/);
    expect(saveMarketLearningProposal({
      insights: [{ finding: 'The first observed reply was positive.', evidence: 'One real activation replied.', confidence: 'low', action: 'Collect more outcomes before changing anything.' }],
    })).toMatchObject({ status: 'PENDING_REVIEW', real_outcomes: 1, boundary_changed: false });
    expect(all('SELECT * FROM market_learning_proposals')).toHaveLength(1);
  });
});
