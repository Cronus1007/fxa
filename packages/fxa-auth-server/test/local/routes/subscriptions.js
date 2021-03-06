/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const sinon = require('sinon');
const assert = { ...sinon.assert, ...require('chai').assert };
const uuid = require('uuid');
const { getRoute } = require('../../routes_helpers');
const mocks = require('../../mocks');
const error = require('../../../lib/error');
const P = require('../../../lib/promise');
const Sentry = require('@sentry/node');
const {
  StripeHelper,
  SUBSCRIPTION_UPDATE_TYPES,
} = require('../../../lib/payments/stripe');
const WError = require('verror').WError;
const uuidv4 = require('uuid').v4;
const moment = require('moment');

const {
  sanitizePlans,
  handleAuth,
  DirectStripeRoutes,
} = require('../../../lib/routes/subscriptions');

const {
  filterCustomer,
  filterSubscription,
  filterInvoice,
  filterIntent,
} = require('fxa-shared').subscriptions.stripe;

const subscription2 = require('../payments/fixtures/subscription2.json');
const cancelledSubscription = require('../payments/fixtures/subscription_cancelled.json');
const trialSubscription = require('../payments/fixtures/subscription_trialing.json');
const pastDueSubscription = require('../payments/fixtures/subscription_past_due.json');
const customerFixture = require('../payments/fixtures/customer1.json');
const customerPMIExpanded = require('../payments/fixtures/customer_new_pmi_default_invoice_expanded.json');
const multiPlanSubscription = require('../payments/fixtures/subscription_multiplan.json');
const emptyCustomer = require('../payments/fixtures/customer_new.json');
const subscriptionCreated = require('../payments/fixtures/subscription_created.json');
const subscriptionCreatedIncomplete = require('../payments/fixtures/subscription_created_incomplete.json');
const subscriptionDeleted = require('../payments/fixtures/subscription_deleted.json');
const subscriptionUpdated = require('../payments/fixtures/subscription_updated.json');
const subscriptionUpdatedFromIncomplete = require('../payments/fixtures/subscription_updated_from_incomplete.json');
const eventInvoicePaymentSucceeded = require('../payments/fixtures/event_invoice_payment_succeeded.json');
const eventInvoicePaymentFailed = require('../payments/fixtures/event_invoice_payment_failed.json');
const eventCustomerSubscriptionUpdated = require('../payments/fixtures/event_customer_subscription_updated.json');
const eventCustomerSourceExpiring = require('../payments/fixtures/event_customer_source_expiring.json');
const openInvoice = require('../payments/fixtures/invoice_open.json');
const newSetupIntent = require('../payments/fixtures/setup_intent_new.json');
const stripePlan = require('../payments/fixtures/plan1.json');

let config,
  log,
  db,
  customs,
  push,
  mailer,
  profile,
  routes,
  route,
  request,
  requestOptions;

const SUBSCRIPTIONS_MANAGEMENT_SCOPE =
  'https://identity.mozilla.com/account/subscriptions';

const ACCOUNT_LOCALE = 'en-US';
const TEST_EMAIL = 'test@email.com';
const UID = uuid.v4('binary').toString('hex');
const NOW = Date.now();
const PLAN_ID_1 = 'plan_G93lTs8hfK7NNG';
const PLANS = [
  {
    plan_id: 'firefox_pro_basic_823',
    product_id: 'firefox_pro_basic',
    product_name: 'Firefox Pro Basic',
    interval: 'week',
    amount: '123',
    currency: 'usd',
    plan_metadata: {},
    product_metadata: {
      emailIconURL: 'http://example.com/image.jpg',
      downloadURL: 'http://getfirefox.com',
      capabilities: 'exampleCap0',
      'capabilities:client1': 'exampleCap1',
    },
  },
  {
    plan_id: 'firefox_pro_basic_999',
    product_id: 'firefox_pro_pro',
    product_name: 'Firefox Pro Pro',
    interval: 'month',
    amount: '456',
    currency: 'usd',
    plan_metadata: {},
    product_metadata: {
      'capabilities:client2': 'exampleCap2, exampleCap4',
    },
  },
  {
    plan_id: PLAN_ID_1,
    product_id: 'prod_G93l8Yn7XJHYUs',
    product_name: 'FN Tier 1',
    interval: 'month',
    amount: 499,
    current: 'usd',
    plan_metadata: {
      'capabilities:client1': 'exampleCap3',
      // NOTE: whitespace in capabilities list should be flexible for human entry
      'capabilities:client2': 'exampleCap5,exampleCap6,   exampleCap7',
    },
    product_metadata: {},
  },
];
const SUBSCRIPTION_ID_1 = 'sub-8675309';
const ACTIVE_SUBSCRIPTIONS = [
  {
    uid: UID,
    subscriptionId: SUBSCRIPTION_ID_1,
    productId: PLANS[0].product_id,
    createdAt: NOW,
    cancelledAt: null,
  },
];

const MOCK_CLIENT_ID = '3c49430b43dfba77';
const MOCK_TTL = 3600;
const MOCK_SCOPES = ['profile:email', SUBSCRIPTIONS_MANAGEMENT_SCOPE];

function runTest(routePath, requestOptions, payments = null) {
  routes = require('../../../lib/routes/subscriptions')(
    log,
    db,
    config,
    customs,
    push,
    mailer,
    profile,
    payments
  );
  route = getRoute(routes, routePath, requestOptions.method || 'GET');
  request = mocks.mockRequest(requestOptions);
  request.emitMetricsEvent = sinon.spy(() => P.resolve({}));

  return route.handler(request);
}

/**
 * To prevent the modification of the test objects loaded, which can impact other tests referencing the object,
 * a deep copy of the object can be created which uses the test object as a template
 *
 * @param {Object} object
 */
function deepCopy(object) {
  return JSON.parse(JSON.stringify(object));
}

describe('sanitizePlans', () => {
  it('removes capabilities from product & plan metadata', () => {
    const expected = [
      {
        plan_id: 'firefox_pro_basic_823',
        product_id: 'firefox_pro_basic',
        product_name: 'Firefox Pro Basic',
        interval: 'week',
        amount: '123',
        currency: 'usd',
        plan_metadata: {},
        product_metadata: {
          emailIconURL: 'http://example.com/image.jpg',
          downloadURL: 'http://getfirefox.com',
        },
      },
      {
        plan_id: 'firefox_pro_basic_999',
        product_id: 'firefox_pro_pro',
        product_name: 'Firefox Pro Pro',
        interval: 'month',
        amount: '456',
        currency: 'usd',
        plan_metadata: {},
        product_metadata: {},
      },
      {
        plan_id: PLAN_ID_1,
        product_id: 'prod_G93l8Yn7XJHYUs',
        product_name: 'FN Tier 1',
        interval: 'month',
        amount: 499,
        current: 'usd',
        plan_metadata: {},
        product_metadata: {},
      },
    ];

    assert.deepEqual(sanitizePlans(PLANS), expected);
  });
});

/**
 * Direct Stripe integration tests
 */
describe('subscriptions directRoutes', () => {
  beforeEach(() => {
    config = {
      subscriptions: {
        enabled: true,
        managementClientId: MOCK_CLIENT_ID,
        managementTokenTTL: MOCK_TTL,
        stripeApiKey: 'sk_test_1234',
      },
    };

    log = mocks.mockLog();
    customs = mocks.mockCustoms();

    db = mocks.mockDB({
      uid: UID,
      email: TEST_EMAIL,
      locale: ACCOUNT_LOCALE,
    });
    db.createAccountSubscription = sinon.spy(async (data) => ({}));
    db.deleteAccountSubscription = sinon.spy(
      async (uid, subscriptionId) => ({})
    );
    db.cancelAccountSubscription = sinon.spy(async () => ({}));
    db.fetchAccountSubscriptions = sinon.spy(async (uid) =>
      ACTIVE_SUBSCRIPTIONS.filter((s) => s.uid === uid)
    );
    db.getAccountSubscription = sinon.spy(async (uid, subscriptionId) => {
      const subscription = ACTIVE_SUBSCRIPTIONS.filter(
        (s) => s.uid === uid && s.subscriptionId === subscriptionId
      )[0];
      if (typeof subscription === 'undefined') {
        throw { statusCode: 404, errno: 116 };
      }
      return subscription;
    });

    push = mocks.mockPush();
    mailer = mocks.mockMailer();

    profile = mocks.mockProfile({
      deleteCache: sinon.spy(async (uid) => ({})),
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  const VALID_REQUEST = {
    auth: {
      credentials: {
        scope: MOCK_SCOPES,
        user: `${UID}`,
        email: `${TEST_EMAIL}`,
      },
    },
  };

  describe('Plans', () => {
    it('should list available subscription plans', async () => {
      const stripeHelper = mocks.mockStripeHelper(['allPlans']);

      stripeHelper.allPlans = sinon.spy(async () => {
        return PLANS;
      });

      const directStripeRoutes = new DirectStripeRoutes(
        log,
        db,
        config,
        customs,
        push,
        mailer,
        profile,
        stripeHelper
      );

      const res = await directStripeRoutes.listPlans(VALID_REQUEST);
      assert.deepEqual(res, sanitizePlans(PLANS));
    });
  });

  describe('listActive', () => {
    it('should list active subscriptions', async () => {
      const stripeHelper = mocks.mockStripeHelper(['customer']);

      stripeHelper.customer = sinon.spy(async (uid, customer) => {
        return customerFixture;
      });

      const directStripeRoutes = new DirectStripeRoutes(
        log,
        db,
        config,
        customs,
        push,
        mailer,
        profile,
        stripeHelper
      );

      const expected = [
        {
          cancelledAt: null,
          createdAt: 1582765012000,
          productId: 'prod_test1',
          subscriptionId: 'sub_test1',
          uid: UID,
        },
      ];
      const res = await directStripeRoutes.listActive(VALID_REQUEST);
      assert.deepEqual(res, expected);
    });
  });

  describe('GET /oauth/subscriptions/search', () => {
    let reqOpts, stripeHelper;
    const customer = deepCopy(customerFixture);

    beforeEach(() => {
      customer.subscriptions.data[0].metadata = {
        previous_plan_id: 'plan_123',
        plan_change_date: '1588962638',
      };
      reqOpts = {
        ...requestOptions,
        method: 'GET',
        query: { uid: UID, email: 'testo@blackhole.example.io' },
        auth: { strategy: 'supportPanelSecret' },
      };

      stripeHelper = sinon.createStubInstance(StripeHelper);
      stripeHelper.customer.resolves(customer);
      stripeHelper.expandResource.resolves(stripePlan);
      stripeHelper.findPlanById.resolves(PLANS[0]);
      stripeHelper.formatSubscriptionsForSupport.restore();
    });

    it('should return a formatted list of subscriptions in the customer response', async () => {
      const sub = customer.subscriptions.data[0];
      const expected = [
        {
          created: sub.created,
          current_period_end: sub.current_period_end,
          current_period_start: sub.current_period_start,
          plan_changed: 1588962638,
          previous_product: PLANS[0].product_name,
          product_name: stripePlan.name,
          status: sub.status,
          subscription_id: sub.id,
        },
      ];

      const response = await runTest(
        '/oauth/subscriptions/search',
        reqOpts,
        stripeHelper
      );
      sinon.assert.calledOnceWithExactly(stripeHelper.customer, {
        uid: reqOpts.query.uid,
        email: reqOpts.query.email,
      });
      assert.deepEqual(response, expected);
    });
  });
});

describe('handleAuth', () => {
  const AUTH_UID = uuid.v4('binary').toString('hex');
  const AUTH_EMAIL = 'auth@example.com';
  const DB_EMAIL = 'db@example.com';

  const VALID_AUTH = {
    credentials: {
      scope: MOCK_SCOPES,
      user: `${AUTH_UID}`,
      email: `${AUTH_EMAIL}`,
    },
  };

  const INVALID_AUTH = {
    credentials: {
      scope: 'profile',
      user: `${AUTH_UID}`,
      email: `${AUTH_EMAIL}`,
    },
  };

  let db;

  before(() => {
    db = mocks.mockDB({
      uid: AUTH_UID,
      email: DB_EMAIL,
      locale: ACCOUNT_LOCALE,
    });
  });

  it('throws an error when the scope is invalid', async () => {
    return handleAuth(db, INVALID_AUTH).then(
      () => Promise.reject(new Error('Method expected to reject')),
      (err) => {
        assert.instanceOf(err, WError);
        assert.equal(err.message, 'Requested scopes are not allowed');
      }
    );
  });

  describe('when fetchEmail is set to false', () => {
    it('returns the uid and the email from the auth header', async () => {
      const expected = { uid: AUTH_UID, email: AUTH_EMAIL };
      const actual = await handleAuth(db, VALID_AUTH);
      assert.deepEqual(actual, expected);
    });
  });

  describe('when fetchEmail is set to true', () => {
    it('returns the uid from the auth credentials and fetches the email from the database', async () => {
      const expected = { uid: AUTH_UID, email: DB_EMAIL };
      const actual = await handleAuth(db, VALID_AUTH, true);
      assert.deepEqual(actual, expected);
    });

    it('should propogate errors from database', async () => {
      let failed = false;

      db.account = sinon.spy(async () => {
        throw error.unknownAccount();
      });

      await handleAuth(db, VALID_AUTH, true).then(
        () => Promise.reject(new Error('Method expected to reject')),
        (err) => {
          failed = true;
          assert.equal(err.message, 'Unknown account');
        }
      );

      assert.isTrue(failed);
    });
  });
});

describe('DirectStripeRoutes', () => {
  let sandbox;
  let directStripeRoutesInstance;

  const VALID_REQUEST = {
    auth: {
      credentials: {
        scope: MOCK_SCOPES,
        user: `${UID}`,
        email: `${TEST_EMAIL}`,
      },
    },
    app: {
      devices: ['deviceId1', 'deviceId2'],
    },
  };

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    config = {
      subscriptions: {
        enabled: true,
        managementClientId: MOCK_CLIENT_ID,
        managementTokenTTL: MOCK_TTL,
        stripeApiKey: 'sk_test_1234',
      },
    };

    log = mocks.mockLog();
    customs = mocks.mockCustoms();
    profile = mocks.mockProfile({
      deleteCache: sinon.spy(async (uid) => ({})),
    });
    mailer = mocks.mockMailer();

    db = mocks.mockDB({
      uid: UID,
      email: TEST_EMAIL,
      locale: ACCOUNT_LOCALE,
    });
    const stripeHelperMock = sandbox.createStubInstance(StripeHelper);

    directStripeRoutesInstance = new DirectStripeRoutes(
      log,
      db,
      config,
      customs,
      push,
      mailer,
      profile,
      stripeHelperMock
    );
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('customerChanged', () => {
    it('Creates profile update push notification and logs profile changed event', async () => {
      await directStripeRoutesInstance.customerChanged(
        VALID_REQUEST,
        UID,
        TEST_EMAIL
      );
      assert.isTrue(
        directStripeRoutesInstance.stripeHelper.refreshCachedCustomer.calledOnceWith(
          UID,
          TEST_EMAIL
        ),
        'Expected stripeHelper.refreshCachedCustomer to be called once'
      );

      assert.isTrue(
        directStripeRoutesInstance.profile.deleteCache.calledOnceWith(UID),
        'Expected profile.deleteCache to be called once'
      );

      assert.isTrue(
        directStripeRoutesInstance.push.notifyProfileUpdated.calledOnceWith(
          UID,
          VALID_REQUEST.app.devices
        ),
        'Expected push.notifyProfileUpdated to be called once'
      );

      assert.isTrue(
        directStripeRoutesInstance.log.notifyAttachedServices.calledOnceWith(
          'profileDataChanged',
          VALID_REQUEST,
          { uid: UID, email: TEST_EMAIL }
        ),
        'Expected log.notifyAttachedServices to be called'
      );
    });
  });

  describe('getClients', () => {
    it('returns the clients and their capabilities', async () => {
      directStripeRoutesInstance.stripeHelper.allPlans.resolves(PLANS);

      const expected = [
        {
          clientId: 'client1',
          capabilities: ['exampleCap0', 'exampleCap1', 'exampleCap3'],
        },
        {
          clientId: 'client2',
          capabilities: [
            'exampleCap0',
            'exampleCap2',
            'exampleCap4',
            'exampleCap5',
            'exampleCap6',
            'exampleCap7',
          ],
        },
      ];

      const actual = await directStripeRoutesInstance.getClients();
      assert.deepEqual(actual, expected, 'Clients were not returned correctly');
    });
  });

  describe('createCustomer', () => {
    it('creates a stripe customer', async () => {
      const expected = deepCopy(emptyCustomer);
      directStripeRoutesInstance.stripeHelper.createPlainCustomer.resolves(
        expected
      );
      VALID_REQUEST.payload = {
        displayName: 'Jane Doe',
        idempotencyKey: uuidv4(),
      };

      const actual = await directStripeRoutesInstance.createCustomer(
        VALID_REQUEST
      );

      assert.deepEqual(filterCustomer(expected), actual);
    });
  });

  describe('createSubscriptionWithPMI', () => {
    const plan = PLANS[2];

    beforeEach(() => {
      directStripeRoutesInstance.stripeHelper.findPlanById.resolves(plan);
      sandbox.stub(directStripeRoutesInstance, 'customerChanged').resolves();
    });

    it('creates a subscription with a payment method', async () => {
      const sourceCountry = 'us';
      directStripeRoutesInstance.stripeHelper.extractSourceCountryFromSubscription.returns(
        sourceCountry
      );
      const customer = deepCopy(emptyCustomer);
      directStripeRoutesInstance.stripeHelper.customer.resolves(customer);
      const expected = deepCopy(subscription2);
      directStripeRoutesInstance.stripeHelper.createSubscriptionWithPMI.resolves(
        expected
      );
      VALID_REQUEST.payload = {
        priceId: 'Jane Doe',
        paymentMethodId: 'pm_asdf',
        idempotencyKey: uuidv4(),
      };

      const actual = await directStripeRoutesInstance.createSubscriptionWithPMI(
        VALID_REQUEST
      );

      sinon.assert.calledWith(
        directStripeRoutesInstance.customerChanged,
        VALID_REQUEST,
        UID,
        TEST_EMAIL
      );

      assert.deepEqual(
        {
          sourceCountry,
          subscription: filterSubscription(expected),
        },
        actual
      );
    });

    it('errors when a customer has not been created', async () => {
      directStripeRoutesInstance.stripeHelper.customer.resolves(undefined);
      VALID_REQUEST.payload = {
        displayName: 'Jane Doe',
        idempotencyKey: uuidv4(),
      };
      try {
        await directStripeRoutesInstance.createSubscriptionWithPMI(
          VALID_REQUEST
        );
        assert.fail('Create subscription without a customer should fail.');
      } catch (err) {
        assert.instanceOf(err, WError);
        assert.equal(err.errno, error.ERRNO.UNKNOWN_SUBSCRIPTION_CUSTOMER);
      }
    });

    it('creates a subscription without an payment id in the request', async () => {
      const sourceCountry = 'us';
      directStripeRoutesInstance.stripeHelper.extractSourceCountryFromSubscription.returns(
        sourceCountry
      );
      const customer = deepCopy(emptyCustomer);
      directStripeRoutesInstance.stripeHelper.customer.resolves(customer);
      const expected = deepCopy(subscription2);
      directStripeRoutesInstance.stripeHelper.createSubscriptionWithPMI.resolves(
        expected
      );
      const idempotencyKey = uuidv4();

      VALID_REQUEST.payload = {
        priceId: 'quux',
        idempotencyKey,
      };

      const actual = await directStripeRoutesInstance.createSubscriptionWithPMI(
        VALID_REQUEST
      );

      assert.deepEqual(
        {
          sourceCountry,
          subscription: filterSubscription(expected),
        },
        actual
      );
      sinon.assert.calledWith(
        directStripeRoutesInstance.stripeHelper.createSubscriptionWithPMI,
        {
          customerId: customer.id,
          priceId: 'quux',
          paymentMethodId: undefined,
          subIdempotencyKey: `${idempotencyKey}-createSub`,
        }
      );
      sinon.assert.calledWith(
        directStripeRoutesInstance.customerChanged,
        VALID_REQUEST,
        UID,
        TEST_EMAIL
      );
    });
  });

  describe('retryInvoice', () => {
    it('retries the invoice with the payment method', async () => {
      const customer = deepCopy(emptyCustomer);
      directStripeRoutesInstance.stripeHelper.customer.resolves(customer);
      const expected = deepCopy(openInvoice);
      directStripeRoutesInstance.stripeHelper.retryInvoiceWithPaymentId.resolves(
        expected
      );
      sinon.stub(directStripeRoutesInstance, 'customerChanged').resolves();
      VALID_REQUEST.payload = {
        invoiceId: 'in_testinvoice',
        paymentMethodId: 'pm_asdf',
        idempotencyKey: uuidv4(),
      };

      const actual = await directStripeRoutesInstance.retryInvoice(
        VALID_REQUEST
      );

      sinon.assert.calledWith(
        directStripeRoutesInstance.customerChanged,
        VALID_REQUEST,
        UID,
        TEST_EMAIL
      );

      assert.deepEqual(filterInvoice(expected), actual);
    });

    it('errors when a customer has not been created', async () => {
      directStripeRoutesInstance.stripeHelper.customer.resolves(undefined);
      VALID_REQUEST.payload = {
        displayName: 'Jane Doe',
        idempotencyKey: uuidv4(),
      };
      try {
        await directStripeRoutesInstance.retryInvoice(VALID_REQUEST);
        assert.fail('Create customer should fail.');
      } catch (err) {
        assert.instanceOf(err, WError);
        assert.equal(err.errno, error.ERRNO.UNKNOWN_SUBSCRIPTION_CUSTOMER);
      }
    });
  });

  describe('createSetupIntent', () => {
    it('creates a new setup intent', async () => {
      const customer = deepCopy(emptyCustomer);
      directStripeRoutesInstance.stripeHelper.customer.resolves(customer);
      const expected = deepCopy(newSetupIntent);
      directStripeRoutesInstance.stripeHelper.createSetupIntent.resolves(
        expected
      );
      VALID_REQUEST.payload = {};

      const actual = await directStripeRoutesInstance.createSetupIntent(
        VALID_REQUEST
      );

      assert.deepEqual(filterIntent(expected), actual);
    });

    it('errors when a customer has not been created', async () => {
      VALID_REQUEST.payload = {};
      try {
        await directStripeRoutesInstance.createSetupIntent(VALID_REQUEST);
        assert.fail('Create customer should fail.');
      } catch (err) {
        assert.instanceOf(err, WError);
        assert.equal(err.errno, error.ERRNO.UNKNOWN_SUBSCRIPTION_CUSTOMER);
      }
    });
  });

  describe('updateDefaultPaymentMethod', () => {
    it('updates the default payment method', async () => {
      const customer = deepCopy(emptyCustomer);
      const paymentMethodId = 'card_1G9Vy3Kb9q6OnNsLYw9Zw0Du';

      const expected = deepCopy(emptyCustomer);
      expected.invoice_settings.default_payment_method = paymentMethodId;

      directStripeRoutesInstance.stripeHelper.customer
        .onCall(0)
        .resolves(customer);
      directStripeRoutesInstance.stripeHelper.customer
        .onCall(1)
        .resolves(expected);
      directStripeRoutesInstance.stripeHelper.updateDefaultPaymentMethod.resolves(
        customer
      );
      directStripeRoutesInstance.stripeHelper.removeSources.resolves([
        {},
        {},
        {},
      ]);

      VALID_REQUEST.payload = {
        paymentMethodId,
      };

      const actual = await directStripeRoutesInstance.updateDefaultPaymentMethod(
        VALID_REQUEST
      );

      assert.deepEqual(filterCustomer(expected), actual);
      sinon.assert.calledOnce(
        directStripeRoutesInstance.stripeHelper.removeSources
      );
    });

    it('errors when a customer has not been created', async () => {
      VALID_REQUEST.payload = { paymentMethodId: 'pm_asdf' };
      try {
        await directStripeRoutesInstance.updateDefaultPaymentMethod(
          VALID_REQUEST
        );
        assert.fail('Create customer should fail.');
      } catch (err) {
        assert.instanceOf(err, WError);
        assert.equal(err.errno, error.ERRNO.UNKNOWN_SUBSCRIPTION_CUSTOMER);
      }
    });
  });

  describe('detachFailedPaymentMethod', () => {
    it('calls stripe helper to detach the payment method', async () => {
      const customer = deepCopy(customerFixture);
      customer.subscriptions.data[0].status = 'incomplete';
      const paymentMethodId = 'pm_9001';
      const expected = { id: paymentMethodId, isGood: 'yep' };

      directStripeRoutesInstance.stripeHelper.customer.resolves(customer);
      directStripeRoutesInstance.stripeHelper.detachPaymentMethod.resolves(
        expected
      );

      VALID_REQUEST.payload = {
        paymentMethodId,
      };

      const actual = await directStripeRoutesInstance.detachFailedPaymentMethod(
        VALID_REQUEST
      );

      assert.deepEqual(actual, expected);
      sinon.assert.calledOnceWithExactly(
        directStripeRoutesInstance.stripeHelper.detachPaymentMethod,
        paymentMethodId
      );
    });

    it('does not detach if the subscription is not "incomplete"', async () => {
      const customer = deepCopy(customerFixture);
      const paymentMethodId = 'pm_9001';
      const resp = { id: paymentMethodId, isGood: 'yep' };

      directStripeRoutesInstance.stripeHelper.customer.resolves(customer);
      directStripeRoutesInstance.stripeHelper.detachPaymentMethod.resolves(
        resp
      );

      VALID_REQUEST.payload = {
        paymentMethodId,
      };
      const actual = await directStripeRoutesInstance.detachFailedPaymentMethod(
        VALID_REQUEST
      );

      assert.deepEqual(actual, { id: paymentMethodId });
      sinon.assert.notCalled(
        directStripeRoutesInstance.stripeHelper.detachPaymentMethod
      );
    });

    it('errors when a customer has not been created', async () => {
      VALID_REQUEST.payload = { paymentMethodId: 'pm_asdf' };
      try {
        await directStripeRoutesInstance.detachFailedPaymentMethod(
          VALID_REQUEST
        );
        assert.fail(
          'Detaching a payment method from a non-existent customer should fail.'
        );
      } catch (err) {
        assert.instanceOf(err, WError);
        assert.equal(err.errno, error.ERRNO.UNKNOWN_SUBSCRIPTION_CUSTOMER);
      }
    });
  });

  describe('findCustomerSubscriptionByPlanId', () => {
    describe('Customer has Single One-Plan Subscription', () => {
      const customer = deepCopy(customerFixture);
      customer.subscriptions.data = [subscription2];
      it('returns the Subscription when the plan id is found', () => {
        const expected = customer.subscriptions.data[0];
        const actual = directStripeRoutesInstance.findCustomerSubscriptionByPlanId(
          customer,
          customer.subscriptions.data[0].items.data[0].plan.id
        );

        assert.deepEqual(actual, expected);
      });

      it('returns `undefined` when the plan id is not found', () => {
        assert.isUndefined(
          directStripeRoutesInstance.findCustomerSubscriptionByPlanId(
            customer,
            'plan_test2'
          )
        );
      });
    });

    describe('Customer has Single Multi-Plan Subscription', () => {
      const customer = deepCopy(customerFixture);
      customer.subscriptions.data = [multiPlanSubscription];

      it('returns the Subscription when the plan id is found - first in array', () => {
        const expected = customer.subscriptions.data[0];
        const actual = directStripeRoutesInstance.findCustomerSubscriptionByPlanId(
          customer,
          'plan_1'
        );

        assert.deepEqual(actual, expected);
      });

      it('returns the Subscription when the plan id is found - not first in array', () => {
        const expected = customer.subscriptions.data[0];
        const actual = directStripeRoutesInstance.findCustomerSubscriptionByPlanId(
          customer,
          'plan_2'
        );

        assert.deepEqual(actual, expected);
      });

      it('returns `undefined` when the plan id is not found', () => {
        assert.isUndefined(
          directStripeRoutesInstance.findCustomerSubscriptionByPlanId(
            customer,
            'plan_3'
          )
        );
      });
    });

    describe('Customer has Multiple Subscriptions', () => {
      const customer = deepCopy(customerFixture);
      customer.subscriptions.data = [multiPlanSubscription, subscription2];

      it('returns the Subscription when the plan id is found in the first subscription', () => {
        const expected = customer.subscriptions.data[0];
        const actual = directStripeRoutesInstance.findCustomerSubscriptionByPlanId(
          customer,
          'plan_2'
        );

        assert.deepEqual(actual, expected);
      });

      it('returns the Subscription when the plan id is found in not the first subscription', () => {
        const expected = customer.subscriptions.data[1];
        const actual = directStripeRoutesInstance.findCustomerSubscriptionByPlanId(
          customer,
          'plan_G93mMKnIFCjZek'
        );

        assert.deepEqual(actual, expected);
      });

      it('returns `undefined` when the plan id is not found', () => {
        assert.isUndefined(
          directStripeRoutesInstance.findCustomerSubscriptionByPlanId(
            customer,
            'plan_test2'
          )
        );
      });
    });
  });

  describe('findCustomerSubscriptionByProductId', () => {
    describe('Customer has Single One-Plan Subscription', () => {
      const customer = deepCopy(customerFixture);
      customer.subscriptions.data = [subscription2];
      it('returns the Subscription when the plan id is found', () => {
        const expected = customer.subscriptions.data[0];
        const actual = directStripeRoutesInstance.findCustomerSubscriptionByProductId(
          customer,
          customer.subscriptions.data[0].items.data[0].plan.product
        );

        assert.deepEqual(actual, expected);
      });

      it('returns `undefined` when the plan id is not found', () => {
        assert.isUndefined(
          directStripeRoutesInstance.findCustomerSubscriptionByProductId(
            customer,
            'prod_test2'
          )
        );
      });
    });

    describe('Customer has Single Multi-Plan Subscription', () => {
      const customer = deepCopy(customerFixture);
      customer.subscriptions.data = [multiPlanSubscription];

      it('returns the Subscription when the product id is found - first in array', () => {
        const expected = customer.subscriptions.data[0];
        const actual = directStripeRoutesInstance.findCustomerSubscriptionByProductId(
          customer,
          'prod_GgIk7jEVeDK06M'
        );

        assert.deepEqual(actual, expected);
      });

      it('returns the Subscription when the product id is found - not first in array', () => {
        const expected = customer.subscriptions.data[0];
        const actual = directStripeRoutesInstance.findCustomerSubscriptionByProductId(
          customer,
          'prod_GgIlYvvmpprKAy'
        );

        assert.deepEqual(actual, expected);
      });

      it('returns `undefined` when the plan id is not found', () => {
        assert.isUndefined(
          directStripeRoutesInstance.findCustomerSubscriptionByProductId(
            customer,
            'prod_3'
          )
        );
      });
    });

    describe('Customer has Multiple Subscriptions', () => {
      const customer = deepCopy(customerFixture);
      customer.subscriptions.data = [multiPlanSubscription, subscription2];

      it('returns the Subscription when the product id is found in the first subscription', () => {
        const expected = customer.subscriptions.data[0];
        const actual = directStripeRoutesInstance.findCustomerSubscriptionByProductId(
          customer,
          'prod_GgIk7jEVeDK06M'
        );

        assert.deepEqual(actual, expected);
      });

      it('returns the Subscription when the product id is found in not the first subscription', () => {
        const expected = customer.subscriptions.data[1];
        const actual = directStripeRoutesInstance.findCustomerSubscriptionByProductId(
          customer,
          'prod_G93mdk6bGPJ7wy'
        );

        assert.deepEqual(actual, expected);
      });

      it('returns `undefined` when the product id is not found', () => {
        assert.isUndefined(
          directStripeRoutesInstance.findCustomerSubscriptionByProductId(
            customer,
            'product_test2'
          )
        );
      });
    });
  });

  describe('deleteSubscription', () => {
    const deleteSubRequest = {
      auth: {
        credentials: {
          scope: MOCK_SCOPES,
          user: `${UID}`,
          email: `${TEST_EMAIL}`,
        },
      },
      app: {
        devices: ['deviceId1', 'deviceId2'],
      },
      params: { subscriptionId: subscription2.id },
    };

    it('returns the subscription id', async () => {
      const expected = { subscriptionId: subscription2.id };

      directStripeRoutesInstance.stripeHelper.cancelSubscriptionForCustomer.resolves();
      const actual = await directStripeRoutesInstance.deleteSubscription(
        deleteSubRequest
      );

      assert.deepEqual(actual, expected);
    });
  });

  describe('reactivateSubscription', () => {
    const reactivateRequest = {
      auth: {
        credentials: {
          scope: MOCK_SCOPES,
          user: `${UID}`,
          email: `${TEST_EMAIL}`,
        },
      },
      app: {
        devices: ['deviceId1', 'deviceId2'],
      },
      payload: { subscriptionId: subscription2.id },
    };

    it('returns an empty object', async () => {
      directStripeRoutesInstance.stripeHelper.reactivateSubscriptionForCustomer.resolves();
      const actual = await directStripeRoutesInstance.reactivateSubscription(
        reactivateRequest
      );

      assert.isEmpty(actual);
    });
  });

  describe('updateSubscription', () => {
    describe('when the plan is a valid upgrade', () => {
      it('returns the subscription id', async () => {
        const subscriptionId = 'sub_123';
        const expected = { subscriptionId: subscriptionId };

        directStripeRoutesInstance.stripeHelper.subscriptionForCustomer.resolves(
          subscription2
        );
        directStripeRoutesInstance.stripeHelper.verifyPlanUpdateForSubscription.resolves();
        directStripeRoutesInstance.stripeHelper.changeSubscriptionPlan.resolves();

        sinon.stub(directStripeRoutesInstance, 'customerChanged').resolves();

        VALID_REQUEST.params = { subscriptionId: subscriptionId };
        VALID_REQUEST.payload = { planId: 'plan_123' };

        const actual = await directStripeRoutesInstance.updateSubscription(
          VALID_REQUEST
        );

        assert.deepEqual(actual, expected);
      });
    });

    describe('when the orginal subscription is not found', () => {
      it('throws an exception', async () => {
        directStripeRoutesInstance.stripeHelper.subscriptionForCustomer.resolves();
        VALID_REQUEST.params = { subscriptionId: 'sub_123' };
        VALID_REQUEST.payload = { planId: 'plan_123' };

        return directStripeRoutesInstance
          .updateSubscription(VALID_REQUEST)
          .then(
            () => Promise.reject(new Error('Method expected to reject')),
            (err) => {
              assert.instanceOf(err, WError);
              assert.equal(err.errno, error.ERRNO.UNKNOWN_SUBSCRIPTION);
              assert.equal(err.message, 'Unknown subscription');
            }
          );
      });
    });
  });

  describe('getProductName', () => {
    it('should respond with product name for valid id', async () => {
      directStripeRoutesInstance.stripeHelper.allPlans.resolves(PLANS);
      const productId = PLANS[1].product_id;
      const expected = { product_name: PLANS[1].product_name };
      const result = await directStripeRoutesInstance.getProductName({
        auth: {},
        query: { productId },
      });
      assert.deepEqual(expected, result);
    });

    it('should respond with an error for invalid id', async () => {
      directStripeRoutesInstance.stripeHelper.allPlans.resolves(PLANS);
      const productId = 'this-is-not-valid';
      try {
        await directStripeRoutesInstance.getProductName({
          auth: {},
          query: { productId },
        });
        assert.fail('Getting a product name should fail.');
      } catch (err) {
        assert.instanceOf(err, WError);
        assert.equal(err.errno, error.ERRNO.UNKNOWN_SUBSCRIPTION_PLAN);
      }
    });
  });

  describe('listPlans', () => {
    it('returns the available plans when auth headers are valid', async () => {
      const expected = sanitizePlans(PLANS);

      directStripeRoutesInstance.stripeHelper.allPlans.resolves(PLANS);
      const actual = await directStripeRoutesInstance.listPlans(VALID_REQUEST);

      assert.deepEqual(actual, expected);
    });

    it('results in an error when auth headers are invalid', async () => {
      const invalid_request = {
        auth: {
          credentials: {
            scope: ['profile'],
            user: `${UID}`,
            email: `${TEST_EMAIL}`,
          },
        },
      };

      return directStripeRoutesInstance.listPlans(invalid_request).then(
        () => Promise.reject(new Error('Method expected to reject')),
        (err) => {
          assert.instanceOf(err, WError);
          assert.equal(err.message, 'Requested scopes are not allowed');
        }
      );
    });
  });

  describe('getProductCapabilties', () => {
    it('extracts all capabilities for all products', async () => {
      directStripeRoutesInstance.stripeHelper.allPlans.resolves(PLANS);
      assert.deepEqual(
        await directStripeRoutesInstance.getProductCapabilities(
          'firefox_pro_basic'
        ),
        ['exampleCap0', 'exampleCap1']
      );
      assert.deepEqual(
        await directStripeRoutesInstance.getProductCapabilities(
          'prod_G93l8Yn7XJHYUs'
        ),
        ['exampleCap3', 'exampleCap5', 'exampleCap6', 'exampleCap7']
      );
    });
  });

  describe('listActive', () => {
    describe('customer is found', () => {
      describe('customer has no subscriptions', () => {
        it('returns an empty array', async () => {
          directStripeRoutesInstance.stripeHelper.customer.resolves(
            emptyCustomer
          );
          const expected = [];
          const actual = await directStripeRoutesInstance.listActive(
            VALID_REQUEST
          );
          assert.deepEqual(actual, expected);
        });
      });
      describe('customer has subscriptions', () => {
        it('returns only subscriptions that are trialing, active, or past_due', async () => {
          const customer = deepCopy(emptyCustomer);
          const setToCancelSubscription = deepCopy(cancelledSubscription);
          setToCancelSubscription.status = 'active';
          setToCancelSubscription.id = 'sub_123456';
          customer.subscriptions.data = [
            subscription2,
            trialSubscription,
            pastDueSubscription,
            cancelledSubscription,
            setToCancelSubscription,
          ];

          directStripeRoutesInstance.stripeHelper.customer.resolves(customer);

          const activeSubscriptions = await directStripeRoutesInstance.listActive(
            VALID_REQUEST
          );

          assert.lengthOf(activeSubscriptions, 4);
          assert.isDefined(
            activeSubscriptions.find(
              (x) => x.subscriptionId === subscription2.id
            )
          );
          assert.isDefined(
            activeSubscriptions.find(
              (x) => x.subscriptionId === trialSubscription.id
            )
          );
          assert.isDefined(
            activeSubscriptions.find(
              (x) => x.subscriptionId === pastDueSubscription.id
            )
          );
          assert.isDefined(
            activeSubscriptions.find(
              (x) => x.subscriptionId === setToCancelSubscription.id
            )
          );
          assert.isUndefined(
            activeSubscriptions.find(
              (x) => x.subscriptionId === cancelledSubscription.id
            )
          );
        });
      });
    });

    describe('customer is not found', () => {
      it('returns an empty array', async () => {
        directStripeRoutesInstance.stripeHelper.customer.resolves();
        const expected = [];
        const actual = await directStripeRoutesInstance.listActive(
          VALID_REQUEST
        );
        assert.deepEqual(actual, expected);
      });
    });
  });

  describe('getCustomer', () => {
    describe('customer is found', () => {
      let customer;

      beforeEach(() => {
        customer = deepCopy(emptyCustomer);
        directStripeRoutesInstance.stripeHelper.subscriptionsToResponse.resolves(
          []
        );
      });

      describe('customer has payment sources', () => {
        describe('default invoice payment method is a card object', () => {
          it('adds payment method data to the response', async () => {
            directStripeRoutesInstance.stripeHelper.fetchCustomer.resolves(
              customerPMIExpanded
            );

            const defaultInvoice =
              customerPMIExpanded.invoice_settings.default_payment_method;
            const expected = {
              subscriptions: [],
              billing_name: defaultInvoice.billing_details.name,
              brand: defaultInvoice.card.brand,
              payment_type: defaultInvoice.card.funding,
              last4: defaultInvoice.card.last4,
              exp_month: defaultInvoice.card.exp_month,
              exp_year: defaultInvoice.card.exp_year,
            };
            const actual = await directStripeRoutesInstance.getCustomer(
              VALID_REQUEST
            );

            assert.deepEqual(actual, expected);
          });
        });
        describe('default invoice payment method is a string', () => {
          it('throws error as it must be expanded', async () => {
            const customerExpanded = deepCopy(customerPMIExpanded);
            customerExpanded.invoice_settings.default_payment_method =
              'pm_1H0FRp2eZvKYlo2CeIZoc0wj';
            directStripeRoutesInstance.stripeHelper.fetchCustomer.resolves(
              customerExpanded
            );
            try {
              await directStripeRoutesInstance.getCustomer(VALID_REQUEST);
              assert.fail('getCustomer should fail with string payment method');
            } catch (err) {
              assert.strictEqual(
                err.errno,
                error.ERRNO.BACKEND_SERVICE_FAILURE
              );
              assert.strictEqual(
                err.message,
                'A backend service request failed.'
              );
              assert.strictEqual(err.output.payload.service, 'stripe');
            }
          });
        });
        describe('payment source is a card object', () => {
          it('adds source data to the response', async () => {
            directStripeRoutesInstance.stripeHelper.fetchCustomer.resolves(
              customer
            );

            const expected = {
              subscriptions: [],
              billing_name: customer.sources.data[0].name,
              brand: customer.sources.data[0].brand,
              payment_type: customer.sources.data[0].funding,
              last4: customer.sources.data[0].last4,
              exp_month: customer.sources.data[0].exp_month,
              exp_year: customer.sources.data[0].exp_year,
            };
            const actual = await directStripeRoutesInstance.getCustomer(
              VALID_REQUEST
            );

            assert.deepEqual(actual, expected);
          });
        });
        describe('payment source is a source object', () => {
          it('does not add the source data to the response', async () => {
            customer.sources.data[0].object = 'source';
            customer.subscriptions.data = [];
            directStripeRoutesInstance.stripeHelper.fetchCustomer.resolves(
              customer
            );

            const expected = { subscriptions: [] };
            const actual = await directStripeRoutesInstance.getCustomer(
              VALID_REQUEST
            );

            assert.deepEqual(actual, expected);
          });
        });
      });
      describe('customer has no payment sources', () => {
        it('does not add source information to the response', async () => {
          customer.sources.data = [];
          customer.subscriptions.data = [];
          directStripeRoutesInstance.stripeHelper.fetchCustomer.resolves(
            customer
          );

          const expected = { subscriptions: [] };
          const actual = await directStripeRoutesInstance.getCustomer(
            VALID_REQUEST
          );

          assert.deepEqual(actual, expected);
        });
      });
    });
    describe('customer is not found', () => {
      it('throws an error', async () => {
        directStripeRoutesInstance.stripeHelper.fetchCustomer.resolves();

        try {
          await directStripeRoutesInstance.getCustomer(VALID_REQUEST);
          assert.fail(
            'getCustomer should throw an error when a customer is not returned.'
          );
        } catch (err) {
          assert.strictEqual(
            err.errno,
            error.ERRNO.UNKNOWN_SUBSCRIPTION_CUSTOMER
          );
          assert.strictEqual(err.message, 'Unknown customer');
          assert.strictEqual(err.output.payload['uid'], UID);
        }
      });
    });
  });

  describe('sendSubscriptionStatusToSqs', () => {
    it('notifies attached services', async () => {
      const event = deepCopy(subscriptionUpdatedFromIncomplete);
      const subscription = deepCopy(subscription2);
      const sub = { id: subscription.id, productId: subscription.plan.product };

      directStripeRoutesInstance.stripeHelper.allPlans.resolves([
        ...PLANS,
        {
          plan_id: subscription2.plan.id,
          product_id: subscription2.plan.product,
          product_metadata: {
            capabilities: 'foo, bar, baz',
          },
        },
      ]);

      await directStripeRoutesInstance.sendSubscriptionStatusToSqs(
        VALID_REQUEST,
        UID,
        event,
        sub,
        true
      );

      assert.isTrue(
        directStripeRoutesInstance.log.notifyAttachedServices.calledOnceWith(
          'subscription:update',
          VALID_REQUEST,
          {
            uid: UID,
            eventCreatedAt: event.created,
            subscriptionId: sub.id,
            isActive: true,
            productId: sub.productId,
            productCapabilities: ['foo', 'bar', 'baz'],
          }
        ),
        'Expected log.notifyAttachedServices to be called'
      );
    });
  });

  describe('updateCustomerAndSendStatus', () => {
    let event;

    beforeEach(() => {
      event = deepCopy(subscriptionUpdatedFromIncomplete);
      sinon
        .stub(directStripeRoutesInstance, 'sendSubscriptionStatusToSqs')
        .resolves();
    });

    describe('when the customer is found from the subscription', () => {
      it('calls all the update and notification functions', async () => {
        directStripeRoutesInstance.stripeHelper.getCustomerUidEmailFromSubscription.resolves(
          { uid: UID, email: TEST_EMAIL }
        );

        await directStripeRoutesInstance.updateCustomerAndSendStatus(
          VALID_REQUEST,
          event,
          subscription2,
          true
        );

        assert.calledOnce(
          directStripeRoutesInstance.stripeHelper.refreshCachedCustomer
        );
        assert.calledOnce(profile.deleteCache);
        assert.calledOnce(
          directStripeRoutesInstance.sendSubscriptionStatusToSqs
        );
      });
    });

    describe('when the customer is not found from the subscription', () => {
      it('returns without calling anything', async () => {
        directStripeRoutesInstance.stripeHelper.getCustomerUidEmailFromSubscription.resolves(
          { uid: undefined, email: undefined }
        );

        await directStripeRoutesInstance.updateCustomerAndSendStatus(
          VALID_REQUEST,
          event,
          subscription2,
          true
        );

        assert.notCalled(
          directStripeRoutesInstance.stripeHelper.refreshCachedCustomer
        );
        assert.notCalled(profile.deleteCache);
        assert.notCalled(
          directStripeRoutesInstance.sendSubscriptionStatusToSqs
        );
      });
    });
  });

  describe('stripe webhooks', () => {
    let stubSendSubscriptionStatusToSqs;

    beforeEach(() => {
      directStripeRoutesInstance.stripeHelper.getCustomerUidEmailFromSubscription.resolves(
        { uid: UID, email: TEST_EMAIL }
      );
      stubSendSubscriptionStatusToSqs = sandbox
        .stub(directStripeRoutesInstance, 'sendSubscriptionStatusToSqs')
        .resolves(true);
    });

    describe('handleWebhookEvent', () => {
      let scopeContextSpy, scopeSpy;
      const request = {
        payload: {},
        headers: {
          'stripe-signature': 'stripe_123',
        },
      };
      const handlerNames = [
        'handleCustomerCreatedEvent',
        'handleSubscriptionCreatedEvent',
        'handleSubscriptionUpdatedEvent',
        'handleSubscriptionDeletedEvent',
        'handleCustomerSourceExpiringEvent',
        'handleInvoicePaymentSucceededEvent',
        'handleInvoicePaymentFailedEvent',
      ];
      const handlerStubs = {};

      beforeEach(() => {
        for (const handlerName of handlerNames) {
          handlerStubs[handlerName] = sandbox
            .stub(directStripeRoutesInstance, handlerName)
            .resolves();
        }
        scopeContextSpy = sinon.fake();
        scopeSpy = {
          setContext: scopeContextSpy,
        };
        sandbox.replace(Sentry, 'withScope', (fn) => fn(scopeSpy));
      });

      const assertNamedHandlerCalled = (expectedHandlerName = null) => {
        for (const handlerName of handlerNames) {
          const shouldCall =
            expectedHandlerName && handlerName === expectedHandlerName;
          assert.isTrue(
            handlerStubs[handlerName][shouldCall ? 'called' : 'notCalled'],
            `Expected to ${shouldCall ? '' : 'not '}call ${handlerName}`
          );
        }
      };

      const itOnlyCallsThisHandler = (expectedHandlerName, event) =>
        it(`only calls ${expectedHandlerName}`, async () => {
          const createdEvent = deepCopy(event);
          directStripeRoutesInstance.stripeHelper.constructWebhookEvent.returns(
            createdEvent
          );
          await directStripeRoutesInstance.handleWebhookEvent(request);
          assertNamedHandlerCalled(expectedHandlerName);
          assert.isTrue(
            scopeContextSpy.notCalled,
            'Expected to not call Sentry'
          );
        });

      describe('ignorable errors', () => {
        const commonIgnorableErrorTest = (expectedError) => async () => {
          const fixture = deepCopy(eventCustomerSourceExpiring);
          handlerStubs.handleCustomerSourceExpiringEvent.throws(expectedError);
          directStripeRoutesInstance.stripeHelper.constructWebhookEvent.returns(
            fixture
          );
          let errorThrown = null;
          try {
            await directStripeRoutesInstance.handleWebhookEvent(request);
            assert.calledWith(
              directStripeRoutesInstance.log.error,
              'subscriptions.handleWebhookEvent.failure',
              { error: expectedError }
            );
          } catch (err) {
            errorThrown = err;
          }
          assert.isNull(errorThrown);
        };

        it(
          'ignores emailBouncedHard',
          commonIgnorableErrorTest(error.emailBouncedHard(42))
        );

        it(
          'ignores missingSubscriptionForSourceError',
          commonIgnorableErrorTest(
            error.missingSubscriptionForSourceError(
              'extractSourceDetailsForEmail'
            )
          )
        );
      });

      describe('when the event.type is customer.created', () => {
        itOnlyCallsThisHandler('handleCustomerCreatedEvent', {
          data: { object: customerFixture },
          type: 'customer.created',
        });
      });

      describe('when the event.type is customer.subscription.created', () => {
        itOnlyCallsThisHandler(
          'handleSubscriptionCreatedEvent',
          subscriptionCreated
        );
      });

      describe('when the event.type is customer.subscription.updated', () => {
        itOnlyCallsThisHandler(
          'handleSubscriptionUpdatedEvent',
          subscriptionUpdated
        );
      });

      describe('when the event.type is customer.subscription.deleted', () => {
        itOnlyCallsThisHandler(
          'handleSubscriptionDeletedEvent',
          subscriptionDeleted
        );
      });

      describe('when the event.type is customer.source.expiring', () => {
        itOnlyCallsThisHandler(
          'handleCustomerSourceExpiringEvent',
          eventCustomerSourceExpiring
        );
      });

      describe('when the event.type is invoice.payment_succeeded', () => {
        itOnlyCallsThisHandler(
          'handleInvoicePaymentSucceededEvent',
          eventInvoicePaymentSucceeded
        );
      });

      describe('when the event.type is invoice.payment_failed', () => {
        itOnlyCallsThisHandler(
          'handleInvoicePaymentFailedEvent',
          eventInvoicePaymentFailed
        );
      });

      describe('when the event.type is something else', () => {
        it('only calls sentry', async () => {
          const event = deepCopy(subscriptionCreated);
          event.type = 'customer.updated';
          directStripeRoutesInstance.stripeHelper.constructWebhookEvent.returns(
            event
          );
          await directStripeRoutesInstance.handleWebhookEvent(request);
          assertNamedHandlerCalled();
          assert.isTrue(scopeContextSpy.calledOnce, 'Expected to call Sentry');
        });
      });
    });

    const assertSendSubscriptionStatusToSqsCalledWith = (event, isActive) =>
      assert.calledWith(
        stubSendSubscriptionStatusToSqs,
        {},
        UID,
        event,
        { id: event.data.object.id, productId: event.data.object.plan.product },
        isActive
      );

    describe('handleCustomerCreatedEvent', () => {
      it('creates a local db record with the account uid', async () => {
        await directStripeRoutesInstance.handleCustomerCreatedEvent(
          {},
          {
            data: { object: customerFixture },
            type: 'customer.created',
          }
        );

        assert.calledOnceWithExactly(
          directStripeRoutesInstance.db.accountRecord,
          customerFixture.email
        );
        assert.calledOnceWithExactly(
          directStripeRoutesInstance.stripeHelper.createLocalCustomer,
          UID,
          customerFixture
        );
      });
    });

    describe('handleSubscriptionUpdatedEvent', () => {
      let sendSubscriptionUpdatedEmailStub;

      beforeEach(() => {
        sendSubscriptionUpdatedEmailStub = sandbox
          .stub(directStripeRoutesInstance, 'sendSubscriptionUpdatedEmail')
          .resolves({ uid: UID, email: TEST_EMAIL });
      });

      it('emits a notification when transitioning from "incomplete" to "active/trialing"', async () => {
        const updatedEvent = deepCopy(subscriptionUpdatedFromIncomplete);
        await directStripeRoutesInstance.handleSubscriptionUpdatedEvent(
          {},
          updatedEvent
        );
        assert.calledWith(sendSubscriptionUpdatedEmailStub, updatedEvent);
        assert.calledWith(
          directStripeRoutesInstance.stripeHelper.refreshCachedCustomer,
          UID,
          TEST_EMAIL
        );
        assert.calledWith(profile.deleteCache, UID);
        assertSendSubscriptionStatusToSqsCalledWith(updatedEvent, true);
      });

      it('does not emit a notification for any other subscription state change', async () => {
        const updatedEvent = deepCopy(subscriptionUpdated);
        await directStripeRoutesInstance.handleSubscriptionUpdatedEvent(
          {},
          updatedEvent
        );
        assert.calledWith(sendSubscriptionUpdatedEmailStub, updatedEvent);
        assert.notCalled(
          directStripeRoutesInstance.stripeHelper.refreshCachedCustomer
        );
        assert.notCalled(profile.deleteCache);
        assert.notCalled(stubSendSubscriptionStatusToSqs);
      });
    });

    describe('handleSubscriptionDeletedEvent', () => {
      it('sends email and emits a notification when a subscription is deleted', async () => {
        const deletedEvent = deepCopy(subscriptionDeleted);
        const sendSubscriptionDeletedEmailStub = sandbox
          .stub(directStripeRoutesInstance, 'sendSubscriptionDeletedEmail')
          .resolves({ uid: UID, email: TEST_EMAIL });
        await directStripeRoutesInstance.handleSubscriptionDeletedEvent(
          {},
          deletedEvent
        );
        assert.calledWith(
          sendSubscriptionDeletedEmailStub,
          deletedEvent.data.object
        );
        assert.notCalled(
          directStripeRoutesInstance.stripeHelper
            .getCustomerUidEmailFromSubscription
        );
        assert.calledWith(
          directStripeRoutesInstance.stripeHelper.refreshCachedCustomer,
          UID,
          TEST_EMAIL
        );
        assert.calledWith(profile.deleteCache, UID);
        assertSendSubscriptionStatusToSqsCalledWith(deletedEvent, false);
      });
    });

    describe('handleInvoicePaymentSucceededEvent', () => {
      it('sends email and emits a notification when an invoice payment succeeds', async () => {
        const paymentSucceededEvent = deepCopy(eventInvoicePaymentSucceeded);
        const sendSubscriptionInvoiceEmailStub = sandbox
          .stub(directStripeRoutesInstance, 'sendSubscriptionInvoiceEmail')
          .resolves(true);
        const mockSubscription = {
          id: 'test1',
          plan: { product: 'test2' },
        };
        directStripeRoutesInstance.stripeHelper.expandResource.resolves(
          mockSubscription
        );
        await directStripeRoutesInstance.handleInvoicePaymentSucceededEvent(
          {},
          paymentSucceededEvent
        );
        assert.calledWith(
          sendSubscriptionInvoiceEmailStub,
          paymentSucceededEvent.data.object
        );
        assert.notCalled(stubSendSubscriptionStatusToSqs);
      });
    });

    describe('handleInvoicePaymentFailedEvent', () => {
      const mockSubscription = {
        id: 'test1',
        plan: { product: 'test2' },
      };
      let sendSubscriptionPaymentFailedEmailStub;

      beforeEach(() => {
        sendSubscriptionPaymentFailedEmailStub = sandbox
          .stub(
            directStripeRoutesInstance,
            'sendSubscriptionPaymentFailedEmail'
          )
          .resolves(true);
        directStripeRoutesInstance.stripeHelper.expandResource.resolves(
          mockSubscription
        );
      });

      it('sends email and emits a notification when an invoice payment fails', async () => {
        const paymentFailedEvent = deepCopy(eventInvoicePaymentFailed);
        paymentFailedEvent.data.object.billing_reason = 'subscription_cycle';
        await directStripeRoutesInstance.handleInvoicePaymentFailedEvent(
          {},
          paymentFailedEvent
        );
        assert.calledWith(
          sendSubscriptionPaymentFailedEmailStub,
          paymentFailedEvent.data.object
        );
        assert.notCalled(stubSendSubscriptionStatusToSqs);
      });

      it('does not send email during subscription creation flow', async () => {
        const paymentFailedEvent = deepCopy(eventInvoicePaymentFailed);
        paymentFailedEvent.data.object.billing_reason = 'subscription_create';
        await directStripeRoutesInstance.handleInvoicePaymentFailedEvent(
          {},
          paymentFailedEvent
        );
        assert.notCalled(sendSubscriptionPaymentFailedEmailStub);
      });
    });

    describe('handleSubscriptionCreatedEvent', () => {
      it('emits a notification when a new subscription is "active" or "trialing"', async () => {
        const createdEvent = deepCopy(subscriptionCreated);
        await directStripeRoutesInstance.handleSubscriptionCreatedEvent(
          {},
          createdEvent
        );
        assert.calledWith(
          directStripeRoutesInstance.stripeHelper
            .getCustomerUidEmailFromSubscription,
          createdEvent.data.object
        );
        assert.calledWith(
          directStripeRoutesInstance.stripeHelper.refreshCachedCustomer,
          UID,
          TEST_EMAIL
        );
        assert.calledWith(profile.deleteCache, UID);
        assertSendSubscriptionStatusToSqsCalledWith(createdEvent, true);
      });

      it('does not emit a notification for incomplete new subscriptions', async () => {
        const createdEvent = deepCopy(subscriptionCreatedIncomplete);
        await directStripeRoutesInstance.handleSubscriptionCreatedEvent(
          {},
          createdEvent
        );
        assert.notCalled(
          directStripeRoutesInstance.stripeHelper
            .getCustomerUidEmailFromSubscription
        );
        assert.notCalled(
          directStripeRoutesInstance.stripeHelper.refreshCachedCustomer
        );
        assert.notCalled(profile.deleteCache);
        assert.notCalled(stubSendSubscriptionStatusToSqs);
      });
    });
  });

  describe('sendSubscriptionPaymentExpiredEmail', () => {
    const mockSource = {};
    const mockAccount = {
      emails: TEST_EMAIL,
      locale: ACCOUNT_LOCALE,
    };

    it('sends the email with a list of subscriptions', async () => {
      directStripeRoutesInstance.db.account = sandbox
        .stub()
        .resolves(mockAccount);
      directStripeRoutesInstance.mailer.sendMultiSubscriptionsPaymentExpiredEmail = sandbox.stub();
      directStripeRoutesInstance.mailer.sendSubscriptionPaymentExpiredEmail = sandbox.stub();
      const mockCustomer = { uid: UID, subscriptions: [{ id: 'sub_testo' }] };
      directStripeRoutesInstance.stripeHelper.extractSourceDetailsForEmail.resolves(
        mockCustomer
      );

      await directStripeRoutesInstance.sendSubscriptionPaymentExpiredEmail(
        mockSource
      );

      assert.calledOnceWithExactly(
        directStripeRoutesInstance.stripeHelper.extractSourceDetailsForEmail,
        mockSource
      );
      assert.calledOnceWithExactly(directStripeRoutesInstance.db.account, UID);
      sinon.assert.calledOnceWithExactly(
        directStripeRoutesInstance.mailer.sendSubscriptionPaymentExpiredEmail,
        TEST_EMAIL,
        { emails: TEST_EMAIL, locale: ACCOUNT_LOCALE },
        {
          acceptLanguage: ACCOUNT_LOCALE,
          ...mockCustomer,
        }
      );
    });
  });

  describe('sendSubscriptionPaymentFailedEmail', () => {
    it('sends the payment failed email', async () => {
      const invoice = deepCopy(eventInvoicePaymentFailed.data.object);

      const mockInvoiceDetails = { uid: '1234', test: 'fake' };
      directStripeRoutesInstance.stripeHelper.extractInvoiceDetailsForEmail.resolves(
        mockInvoiceDetails
      );

      const mockAccount = { emails: 'fakeemails', locale: 'fakelocale' };
      directStripeRoutesInstance.db.account = sinon.spy(
        async (data) => mockAccount
      );

      await directStripeRoutesInstance.sendSubscriptionPaymentFailedEmail(
        invoice
      );
      assert.calledWith(
        directStripeRoutesInstance.mailer.sendSubscriptionPaymentFailedEmail,
        mockAccount.emails,
        mockAccount,
        {
          acceptLanguage: mockAccount.locale,
          ...mockInvoiceDetails,
        }
      );
    });
  });

  describe('sendSubscriptionInvoiceEmail', () => {
    const commonSendSubscriptionInvoiceEmailTest = (
      expectedMethodName,
      billingReason
    ) => async () => {
      const invoice = deepCopy(eventInvoicePaymentSucceeded.data.object);
      invoice.billing_reason = billingReason;

      const mockInvoiceDetails = { uid: '1234', test: 'fake' };
      directStripeRoutesInstance.stripeHelper.extractInvoiceDetailsForEmail.resolves(
        mockInvoiceDetails
      );

      const mockAccount = { emails: 'fakeemails', locale: 'fakelocale' };
      directStripeRoutesInstance.db.account = sinon.spy(
        async (data) => mockAccount
      );

      await directStripeRoutesInstance.sendSubscriptionInvoiceEmail(invoice);
      assert.calledWith(
        directStripeRoutesInstance.mailer[expectedMethodName],
        mockAccount.emails,
        mockAccount,
        {
          acceptLanguage: mockAccount.locale,
          ...mockInvoiceDetails,
        }
      );
      if (expectedMethodName === 'sendSubscriptionFirstInvoiceEmail') {
        assert.calledWith(
          directStripeRoutesInstance.mailer.sendDownloadSubscriptionEmail,
          mockAccount.emails,
          mockAccount,
          {
            acceptLanguage: mockAccount.locale,
            ...mockInvoiceDetails,
          }
        );
      }
    };

    it(
      'sends the initial invoice email for a newly created subscription',
      commonSendSubscriptionInvoiceEmailTest(
        'sendSubscriptionFirstInvoiceEmail',
        'subscription_create'
      )
    );

    it(
      'sends the subsequent invoice email for billing reasons besides creation',
      commonSendSubscriptionInvoiceEmailTest(
        'sendSubscriptionSubsequentInvoiceEmail',
        'subscription_cycle'
      )
    );
  });

  describe('sendSubscriptionUpdatedEmail', () => {
    const commonSendSubscriptionUpdatedEmailTest = (updateType) => async () => {
      const event = deepCopy(eventCustomerSubscriptionUpdated);

      const mockDetails = {
        uid: '1234',
        test: 'fake',
        updateType,
      };
      directStripeRoutesInstance.stripeHelper.extractSubscriptionUpdateEventDetailsForEmail.resolves(
        mockDetails
      );

      const mockAccount = { emails: 'fakeemails', locale: 'fakelocale' };
      directStripeRoutesInstance.db.account = sinon.spy(
        async (data) => mockAccount
      );

      await directStripeRoutesInstance.sendSubscriptionUpdatedEmail(event);

      const expectedMethodName = {
        [SUBSCRIPTION_UPDATE_TYPES.UPGRADE]: 'sendSubscriptionUpgradeEmail',
        [SUBSCRIPTION_UPDATE_TYPES.DOWNGRADE]: 'sendSubscriptionDowngradeEmail',
        [SUBSCRIPTION_UPDATE_TYPES.REACTIVATION]:
          'sendSubscriptionReactivationEmail',
        [SUBSCRIPTION_UPDATE_TYPES.CANCELLATION]:
          'sendSubscriptionCancellationEmail',
      }[updateType];

      assert.calledWith(
        directStripeRoutesInstance.mailer[expectedMethodName],
        mockAccount.emails,
        mockAccount,
        {
          acceptLanguage: mockAccount.locale,
          ...mockDetails,
        }
      );
    };

    it(
      'sends an upgrade email on subscription upgrade',
      commonSendSubscriptionUpdatedEmailTest(SUBSCRIPTION_UPDATE_TYPES.UPGRADE)
    );

    it(
      'sends a downgrade email on subscription downgrade',
      commonSendSubscriptionUpdatedEmailTest(
        SUBSCRIPTION_UPDATE_TYPES.DOWNGRADE
      )
    );

    it(
      'sends a reactivation email on subscription reactivation',
      commonSendSubscriptionUpdatedEmailTest(
        SUBSCRIPTION_UPDATE_TYPES.REACTIVATION
      )
    );

    it(
      'sends a cancellation email on subscription cancellation',
      commonSendSubscriptionUpdatedEmailTest(
        SUBSCRIPTION_UPDATE_TYPES.CANCELLATION
      )
    );
  });

  describe('sendSubscriptionDeletedEmail', () => {
    const commonSendSubscriptionDeletedEmailTest = (
      accountFound = true,
      subscriptionAlreadyCancelled = false
    ) => async () => {
      const deletedEvent = deepCopy(subscriptionDeleted);
      const subscription = deletedEvent.data.object;

      if (subscriptionAlreadyCancelled) {
        subscription.metadata = {
          cancelled_for_customer_at: moment().unix(),
        };
      }

      const mockInvoiceDetails = {
        uid: '1234',
        test: 'fake',
        email: 'test@example.com',
      };
      directStripeRoutesInstance.stripeHelper.extractInvoiceDetailsForEmail.resolves(
        mockInvoiceDetails
      );

      const mockAccount = { emails: 'fakeemails', locale: 'fakelocale' };
      directStripeRoutesInstance.db.account = sinon.spy(async (data) => {
        if (accountFound) {
          return mockAccount;
        }
        throw error.unknownAccount();
      });

      await directStripeRoutesInstance.sendSubscriptionDeletedEmail(
        subscription
      );

      assert.calledWith(
        directStripeRoutesInstance.stripeHelper.extractInvoiceDetailsForEmail,
        subscription.latest_invoice
      );

      if (accountFound || subscriptionAlreadyCancelled) {
        assert.notCalled(
          directStripeRoutesInstance.mailer.sendSubscriptionAccountDeletionEmail
        );
      } else {
        const fakeAccount = {
          email: mockInvoiceDetails.email,
          uid: mockInvoiceDetails.uid,
          emails: [{ email: mockInvoiceDetails.email, isPrimary: true }],
        };
        assert.calledWith(
          directStripeRoutesInstance.mailer
            .sendSubscriptionAccountDeletionEmail,
          fakeAccount.emails,
          fakeAccount,
          mockInvoiceDetails
        );
      }
    };

    it(
      'does not send a cancellation email on subscription deletion',
      commonSendSubscriptionDeletedEmailTest(true)
    );

    it(
      'sends an account deletion specific email on subscription deletion when account is gone',
      commonSendSubscriptionDeletedEmailTest(false)
    );

    it(
      'does not send a cancellation email on account deletion when the subscription is already cancelled',
      commonSendSubscriptionDeletedEmailTest(false, true)
    );
  });

  describe('getSubscriptions', () => {
    const formatter = (subs) =>
      subs.data.map((s) => ({ subscription_id: s.id }));

    describe('when a customer is found', () => {
      it('returns a formatted version of the customer subscriptions', async () => {
        const customer = deepCopy(emptyCustomer);
        const subscription = deepCopy(subscription2);
        customer.subscriptions.data = [subscription];

        directStripeRoutesInstance.stripeHelper.customer.resolves(customer);
        directStripeRoutesInstance.stripeHelper.subscriptionsToResponse.resolves(
          formatter(customer.subscriptions)
        );

        const expected = formatter(customer.subscriptions);
        const actual = await directStripeRoutesInstance.getSubscriptions(
          VALID_REQUEST
        );

        assert.deepEqual(expected, actual);
        assert.calledOnce(
          directStripeRoutesInstance.stripeHelper.subscriptionsToResponse
        );
      });
    });

    describe('when a customer is not found', () => {
      it('returns an empty array', async () => {
        directStripeRoutesInstance.stripeHelper.customer.resolves(null);

        const expected = [];
        const actual = await directStripeRoutesInstance.getSubscriptions(
          VALID_REQUEST
        );

        assert.deepEqual(expected, actual);
        assert.notCalled(
          directStripeRoutesInstance.stripeHelper.subscriptionsToResponse
        );
      });
    });
  });
});
