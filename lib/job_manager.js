/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var common = require('./common');
var fs = require('fs');
var events = require('events');
var MemoryStream = require('memorystream');
var path = require('path');
var util = require('util');
var vasync = require('vasync');
var verror = require('verror');



///--- Global Objects

var QUEUED_STATE = 'queued';
var RUNNING_STATE = 'running';
var MAX_SECONDS_IN_AUDIT_OBJECT = 60 * 60 * 24 * 7; // 7 days



///--- API

/**
 * This is a simple job manager that attempts to take continuous polling and
 * workflow out of running Marlin jobs.  This is a very simple job
 * manager.  Any concurrent runnings will cause the same job to be run.  It's
 * expected that this runner will be used for infrequent, long running
 * jobs and that logged results aren't time critical.
 *
 * Required Opts:
 *    jobName:           The name of the job, used to detect already-running
 *                       jobs.
 *    jobRoot:           Where the job audit object (jobs.json) will be stored.
 *    mantaClient:       An initialized Manta client.
 *    getJobDefinition:  A function with the following signature:
 *                       function(opts, cb) {
 *                          ...
 *                          cb(err, job);
 *                       }
 *                       It calls cb with the marlin job definition.
 *    getJobObjects:     A function with the following signature:
 *                       function(opts, cb) {
 *                          ...
 *                          cb(err, [object1, object2, ...]);
 *                       }
 *                       All objects must be the full Manta path.
 * Optional Opts:
 *    directories:       Directories to create before the job is run.
 *    assetFile:         Local file to upload as an asset.
 *    assetObject:       Full path to the asset object.
 *    log:               Bunyan logger
 *    preAudit:          A function with the following signature:
 *                       function(job, audit, opts, cb) {
 *                          ...
 *                          cb(err);
 *                       }
 *                       The pre-audit hook will be called once the job has
 *                       completed.  This gives control back to the application
 *                       to add any additional audit information, to cb(err) to
 *                       say that the the *preAudit* step failed (that is, don't
 *                       cb with an error if the job failed), or to preform
 *                       post-job processing steps.
 *    previousJobObject: Will override the location of the previous jobs object
 *                       from $jobRoot/jobs.json to the specified string.
 */
function JobManager(opts, mantaClient, log) {
        var self = this;
        assert.string(opts.jobName, 'opts.jobName');
        assert.string(opts.jobRoot, 'opts.jobRoot');
        assert.object(mantaClient, 'opts.mantaClient');
        assert.func(opts.getJobDefinition, 'opts.getJobDefinition');
        assert.func(opts.getJobObjects, 'opts.getJobObjects');

        self.opts = opts;
        self.log = log;
        if (!self.log) {
                self.log = bunyan.createLogger({
                        'name': 'JobManager',
                        'level': (process.env.LOG_LEVEL || 'info'),
                        'stream': process.stdout
                });
        }
        self.mantaClient = mantaClient;
        self.jobRoot = opts.jobRoot;
        opts.previousJobsObject = opts.previousJobsObject ||
                opts.jobRoot + '/jobs.json';
}

util.inherits(JobManager, events.EventEmitter);
module.exports = JobManager;



///--- APIs

JobManager.prototype.run = function run(cb) {
        var self = this;
        var opts = self.opts;
        self.audit = {
                'audit': true,
                'startedJob': 0,
                'cronFailed': 1,
                'startTime': new Date()
        };


        var jobDisabled = 'JobDisabled';
        function stopIfDisabled(m_opts, subcb) {
                if (m_opts.forceRun) {
                        self.log.info('Forcing job run');
                        subcb();
                        return;
                }
                if (m_opts.disableAllJobs === true) {
                        subcb(new verror.VError({ 'name': jobDisabled },
                                'all jobs are disabled'));
                        return;
                }

                if (m_opts.jobEnabled === false) {
                        subcb(new verror.VError({ 'name': jobDisabled },
                                '%s is disabled', m_opts.jobName));
                        return;
                }

                subcb();
        }

        function invokeGetJobObjects(_, subcb) {
                opts.getJobObjects(opts, function (err, objects) {
                        if (err) {
                                subcb(err);
                                return;
                        }
                        if (!objects || objects.length === 0) {
                                self.log.info('No objects returned from ' +
                                              'getJobObjects.  Not starting ' +
                                              'job.');
                                var e = new Error('No objects provided.');
                                e.shouldNotFatal = true;
                                subcb(e);
                                return;
                        }
                        assert.arrayOfString(objects);
                        opts.objects = objects;
                        subcb();
                });
        }

        function invokeGetJobDefinition(_, subcb) {
                opts.getJobDefinition(opts, function (err, job) {
                        if (err) {
                                subcb(err);
                                return;
                        }
                        assert.object(job);
                        assert.arrayOfObject(job.phases, 'job.phases');

                        // Add the name if they haven't already
                        if (job.name && job.name !== opts.jobName) {
                                subcb(new Error('Given job name doesn\'t ' +
                                                'match opts.jobName.'));
                                return;
                        }

                        if (!job.name) {
                                job.name = opts.jobName;
                        }

                        // Add the asset if they haven't already
                        if (opts.assetObject) {
                                for (var i = 0; i < job.phases.length; ++i) {
                                        var p = job.phases[i];
                                        if (!p.assets) {
                                                p.assets = [];
                                        }
                                        if (p.assets.indexOf(opts.assetObject)
                                            === -1) {
                                                p.assets.push(opts.assetObject);
                                        }
                                }
                        }

                        opts.job = job;
                        subcb();
                });
        }

        function writeAuditRecord() {
                if (opts.noJobStart === undefined ||
                    opts.noJobStart === false) {
                        var a = self.audit;
                        a.endTime = new Date();
                        a.cronRunMillis = (a.endTime.getTime() -
                                           a.startTime.getTime());
                        a.opts = self.opts;
                        self.log.info(a, 'audit');
                }
        }

        vasync.pipeline({
                'funcs': [
                        stopIfDisabled,
                        self.auditPreviousJobs.bind(self),
                        self.checkRunningJobs.bind(self),
                        self.setupDirectories.bind(self),
                        self.setupAssetObject.bind(self),
                        invokeGetJobObjects,
                        invokeGetJobDefinition,
                        self.createMarlinJob.bind(self)
                ],
                'arg': this.opts
        }, function (err) {
                if (err && verror.hasCauseWithName(err, jobDisabled)) {
                        self.log.info(err);
                        writeAuditRecord();
                        cb();
                        return;
                }
                if (err && (err.shouldNotFatal === undefined)) {
                        self.log.fatal(err, 'Error.');
                } else {
                        self.audit.cronFailed = 0;
                }

                self.recordJobs(opts, function (err2) {
                        if (err2 && err2.code !== 'ResourceNotFound' &&
                            err2.code !== 'DirectoryDoesNotExist') {
                                self.log.info(err2, 'Error saving audit.');
                        }

                        writeAuditRecord();

                        //Send back original error
                        cb(err);
                });
        });
};


JobManager.prototype.createMarlinJob = function createMarlinJob(opts, cb) {
        assert.object(opts.job, 'opts.job');

        var self = this;
        var job = opts.job;
        var objects = opts.objects;

        self.log.info({
                job: job,
                objects: objects
        }, 'Marlin Job Definition and Objects');

        if (opts.noJobStart) {
                cb();
                return;
        }

        self.mantaClient.createJob(job, function (err, jobId) {
                if (err) {
                        cb(err);
                        return;
                }

                opts.jobId = jobId;
                //Create the previous job record
                opts.previousJobs[jobId] = {
                        'timeCreated': new Date(),
                        'audited': false
                };

                self.log.info({ jobId: jobId }, 'Created Job.');
                var aopts = {
                        end: true
                };

                //Add objects to job...
                self.mantaClient.addJobKey(jobId, objects, aopts, function (
                        err2) {
                        if (err2) {
                                cb(err2);
                                return;
                        }

                        self.log.info({
                                objects: objects,
                                jobId: jobId
                        }, 'Added objects to job');

                        self.audit.numberOfObjects = objects.length;
                        self.audit.startedJob = 1;
                        cb();
                });
        });
};


JobManager.prototype.setupDirectories = function setupDirectories(opts, cb) {
        if (opts.directories === null || opts.directories === undefined) {
                opts.directories = [];
        }

        var self = this;

        // Add the job root and the asset dir if they don't already exist...
        if (opts.directories.indexOf(opts.jobRoot) === -1) {
                opts.directories.push(opts.jobRoot);
        }

        if (opts.assetObject) {
                var assetDir = path.dirname(opts.assetObject);
                if (opts.directories.indexOf(assetDir) === -1) {
                        opts.directories.push(assetDir);
                }
        }

        // So that we try to create them in order...
        opts.directories.sort();

        var m = self.mantaClient;

        self.log.info(opts.directories, 'Creating directories.');

        var funcs = [];
        var mkdirFunc = function (_, c) { m.mkdir(this.dir, c); };
        for (var i = 0; i < opts.directories.length; ++i) {
                var dir = opts.directories[i];
                funcs.push(mkdirFunc.bind({ dir: dir }));
        }

        vasync.pipeline({
                funcs: funcs
        }, function (err) {
                cb(err);
        });
};


JobManager.prototype.setupAssetObject = function setupAssetObject(opts, cb) {
        if (opts.assetFile === null || opts.assetFile === undefined) {
                cb();
                return;
        }

        assert.string(opts.assetObject, 'opts.assetObject');

        var self = this;
        self.log.info('Setting up asset object.');

        //Upload the bundle to manta
        fs.stat(opts.assetFile, function (err2, stats) {
                if (err2) {
                        cb(err2);
                        return;
                }

                if (!stats.isFile()) {
                        cb(new Error(opts.assetFile +
                                     ' isn\'t a file'));
                        return;
                }

                var o = {
                        copies: 2,
                        size: stats.size
                };

                var s = fs.createReadStream(opts.assetFile);
                var p = opts.assetObject;
                s.pause();
                s.on('open', function () {
                        self.mantaClient.put(p, s, o, function (e) {
                                cb(e);
                        });
                });
        });
};


JobManager.prototype.findRunningJobs = function findRunningJobs(opts, cb) {
        var self = this;

        assert.string(opts.jobName, 'opts.jobName');

        var lopts = { name: opts.jobName };

        self.mantaClient.listJobs(lopts, function (err, res) {
                if (err) {
                        cb(err);
                        return;
                }

                var jobs = [];

                res.on('job', function (job) {
                        jobs.push(job.name);
                });

                res.on('error', function (err2) {
                        cb(err2);
                });

                res.on('end', function () {
                        var jobObjs = [];

                        function checkResults() {
                                var runningJobs = [];
                                for (var j = 0; j < jobObjs.length; ++j) {
                                        if (jobObjs[j].state !== 'done') {
                                                runningJobs.push(jobObjs[j]);
                                        }
                                }
                                if (runningJobs.length === 0) {
                                        cb(null, null);
                                        return;
                                }
                                if (runningJobs.length > 1) {
                                        var message = 'more than one job ' +
                                                'with name found';
                                        self.log.error({
                                                jobs: jobs
                                        }, message);
                                        cb(new Error(message));
                                        return;
                                }
                                cb(null, runningJobs[0]);
                        }

                        var i = 0;
                        function getNextJob() {
                                var jobId = jobs[i];

                                if (!jobId) {
                                        checkResults();
                                        return;
                                }
                                common.getJob({
                                        'client': self.mantaClient,
                                        'jobId': jobs[i]
                                }, function (err3, j) {
                                        if (err3) {
                                                cb(err3);
                                                return;
                                        }
                                        jobObjs.push(j);
                                        ++i;
                                        getNextJob();
                                });
                        }
                        getNextJob();
                });
        });
};


JobManager.prototype.checkRunningJobs = function checkRunningJobs(opts, cb) {
        var self = this;

        self.findRunningJobs(opts, function (err, job) {
                if (err) {
                        cb(err);
                        return;
                }

                if (job && !job.inputDone) {
                        //Check if the job's input is still open, if so,
                        // kill it and continue since it's pointless
                        // to try and resume if we have newer data.
                        self.mantaClient.cancelJob(job.id, function (err2) {
                                self.log.info(job, 'Attempted to cancel job.');
                                cb(err2);
                        });
                } else if (job) {
                        var started = (new Date(job.timeCreated)).getTime() /
                                1000;
                        var now = (new Date()).getTime() / 1000;
                        self.audit.currentJobSecondsRunning =
                                Math.round(now - started);
                        self.log.info(job, 'Job already running.');
                        var err3 = new Error('Job Already running');
                        //Hack... is there a better way?
                        err3.shouldNotFatal = true;
                        cb(err3);
                        return;
                } else {
                        self.log.info('No running jobs, continuing...');
                        cb();
                        return;
                }
        });
};



///--- Auditing previous jobs

JobManager.prototype.auditJob = function auditJob(job, cb) {
        var self = this;

        if (job.state === RUNNING_STATE ||
            job.state === QUEUED_STATE) {
                cb(new Error('Job is still running'));
                return;
        }

        var audit = {
                audit: true,
                id: job.id
        };

        if (job.stats && job.stats.errors) {
                audit.jobErrors = job.stats.errors;
        } else {
                audit.jobErrors = 0;
        }

        audit.timeCreated = job.timeCreated;
                audit.jobDurationMillis =
                Math.round((new Date(job.timeDone)).getTime()) -
                Math.round((new Date(job.timeCreated)).getTime());

        if (self.opts.preAudit) {
                self.opts.preAudit(job, audit, self.opts, function (err) {
                        if (err) {
                                self.log.error({
                                        err: err,
                                        jobId: job.id
                                }, 'preaudit error');
                                cb(err);
                                return;
                        }
                        self.log.info(audit, 'audit');
                        cb(null);
                });
        } else {
                self.log.info(audit, 'audit');
                cb(null);
        }
};


JobManager.prototype.auditPreviousJobs = function auditPreviousJobs(opts, cb) {
        var self = this;

        assert.string(opts.previousJobsObject, 'opts.previousJobsObject');

        self.log.info('Auditing previous jobs.');

        var objPath = opts.previousJobsObject;
        opts.previousJobs = {};

        function gotObject(err, data) {
                if (err && err.code === 'ResourceNotFound') {
                        self.log.info(objPath + ' doesn\'t exist yet, ' +
                                      'continuing.');
                        cb();
                        return;
                }
                if (err) {
                        cb(err);
                        return;
                }

                try {
                        var pJobs = JSON.parse(data);
                        opts.previousJobs = pJobs;
                } catch (err2) {
                        cb(err2);
                        return;
                }

                var jobsToAudit = [];
                var jobsToDelete = [];
                for (var jobId in pJobs) {
                        var job = pJobs[jobId];
                        var now = (new Date()).getTime();
                        var created = (new Date(job.timeCreated)).getTime();
                        var secondsSinceDone = Math.round(
                                (now - created) / 1000);
                        if (!job.audited) {
                                jobsToAudit.push(jobId);
                        }
                        if (secondsSinceDone >
                            MAX_SECONDS_IN_AUDIT_OBJECT) {
                                jobsToDelete.push(jobId);
                        }
                }

                if (jobsToAudit.length === 0) {
                        self.log.info('No jobs to audit.');
                        cb();
                        return;
                }

                // Fetch all jobs
                vasync.forEachParallel({
                        func: common.getJob,
                        inputs: jobsToAudit.map(function (j) {
                                return ({
                                        'jobId': j,
                                        'client': self.mantaClient
                                });
                        })
                }, function (err2, results) {
                        if (err2) {
                                cb(err2);
                                return;
                        }

                        var jobObjects = [];

                        var i;
                        for (i = 0; i < jobsToAudit.length; ++i) {
                                jobObjects.push(results.successes[i]);
                        }

                        // Attempt to audit all jobs
                        vasync.forEachParallel({
                                func: self.auditJob.bind(self),
                                inputs: jobObjects
                        }, function (err3, results2) {
                                for (i = 0; i < jobsToAudit.length; ++i) {
                                        var cJobId = jobsToAudit[i];
                                        var op = results2.operations[i];
                                        self.log.debug({
                                                jobId: cJobId,
                                                status: op.status
                                        }, 'got status for job');
                                        if (op.status === 'ok') {
                                                pJobs[cJobId].audited = true;
                                        }
                                }

                                for (i = 0; i < jobsToDelete.length; ++i) {
                                        var dJobId = jobsToDelete[i];
                                        if (pJobs[dJobId].audited) {
                                                delete pJobs[dJobId];
                                        }
                                }

                                opts.previousJobs = pJobs;
                                cb();
                        });
                });
        }

        common.getObject({
                'client': self.mantaClient,
                'path': objPath
        }, gotObject);
};


JobManager.prototype.recordJobs = function recordJobs(opts, cb) {
        assert.object(opts.previousJobs, 'opts.previousJobs');
        assert.string(opts.previousJobsObject, 'opts.previousJobsObject');

        var self = this;

        var recordString = JSON.stringify(opts.previousJobs);
        var o = { size: Buffer.byteLength(recordString) };
        var s = new MemoryStream();

        var objPath = opts.previousJobsObject;
        self.mantaClient.put(objPath, s, o, function (err2) {
                cb(err2);
        });

        process.nextTick(function () {
                s.write(recordString);
                s.end();
        });
};
