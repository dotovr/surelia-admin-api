var helper = require ("panas").helper;
var co = require("co");
var mongoose = require ("mongoose");
var thunkified = helper.thunkified;
var async = require ("async");
var _ = require ("lodash");
var boom = helper.error;

var ResourceUser = require ("../../resources/user");
var Model = ResourceUser.schemas;
var ResourceQueue = require ("../../resources/commandQueue");
var QueueModel = ResourceQueue.schemas;
var QueueCommands = ResourceQueue.enums.Commands;
var QueueStates = ResourceQueue.enums.States;
var ResourceDomain = require ("../../resources/domain");
var DomainModel = ResourceDomain.schemas;

var policy = require("../../policy");
var UserEnums = ResourceUser.enums(policy);
var UserStates = UserEnums.States;

var Session
try{
  Session = mongoose.model ("Session", {}); 
} catch (err){
  Session = mongoose.model ("Session");
}
 
var ObjectId = mongoose.Types.ObjectId;

var LIMIT = 10;

/**
 * User class
 */
function User (options) {
  this.options = options;
  if (!(this instanceof User)) return new User(options);
  this.name = "user";
}

User.prototype.find = function(ctx, options, cb) {
  var query = {
    state: QueueStates.types.ACTIVE,
  }

  this.search (query, ctx, options, cb);
}


User.prototype.findActive = function(ctx, options, cb) {
  var query = {
    state: UserStates.types.ACTIVE,
  }

  this.search (query, ctx, options, cb);
}

User.prototype.findInactive = function(ctx, options, cb) {
  var query = {
    state: UserStates.types.INACTIVE,
  }

  this.search (query, ctx, options, cb);
}

User.prototype.findPending = function(ctx, options, cb) {
  var query = {
    state: UserStates.types.PENDING,
  }

  this.search (query, ctx, options, cb);
}

User.prototype.findPendingTransaction = function(ctx, options, cb) {
  var query = {
    pendingTransaction: {
      $ne: ObjectId("000000000000000000000000")
    }
  }

  this.search (query, ctx, options, cb);
}

User.prototype.search = function (query, ctx, options, cb) {

  var qs = ctx.query;
  var self = this;
  var domain = ctx.params.domain;

  // skip, limit, sort
  var skip = qs.skip || 0;
  var limit = qs.limit || LIMIT;
  var sort = qs.sort || { _id : -1 };

  // like or exact
  var like = qs.like || {};
  var exact = qs.exact || {};

  // expand
  var expand = qs.expand || [];
  var omit = "-secret -hash -salt -__v -log";

  // for custom operation
  var operator = qs.operator || false;
  var operation = operator && qs.operation ? qs.operation : [];

  if (!operator) {

    for (var key in like) {
      query [key] = new RegExp(like[key], "i");
    }

    for (var key in exact) {
      query [key] = exact[key];
    }

  } else {
    // todo custom operation
    var criterias = [];
    _.map(operation, function (oper){
      var obj = {};
      for (var key in oper) {
        obj[key] = new RegExp(oper[key], "i");
      }
      criterias.push(obj);
    });
    query["$" + operator] = criterias;
  }

  if (options.and) {
    query = { $and : [ query, options.and ]};
  }

  co(function*() {
    if (!(ObjectId.isValid(domain) && typeof(domain) === "object")) {
      domain = yield self.findDomainId(domain);
      if (domain && domain._id) {
        query.domain = domain._id;
      } else {
        var obj = {
          object : "list",
          total : 0,
          count : 0,
          data : []
        }

        cb (null, obj);
       }
    }

    var task = Model.User.find(query, omit);
    var paths = Model.User.schema.paths;
    var keys = Object.keys(paths);

    task.skip (skip);
    task.limit (limit);
    task.sort (sort);

    task.sort({ lastUpdated : -1});

    var promise = task.exec();
    promise.addErrback(cb);
    promise.then(function(retrieved){
      Model.User.count(query, function(err, total){

        if (err) return cb (err);

        var obj = {
          object : "list",
          total : total,
          count : retrieved.length,
          data : retrieved
        }

        cb (null, obj);
      });
    });
  })();
}

User.prototype.findOne = function (ctx, options, cb) {
  var self = this;
  var id = ctx.params.id;
  var domain = ctx.params.domain;
  var qs = ctx.query;

  var _id;
  var query;

  try {
    _id = mongoose.Types.ObjectId(id);
    query = { _id : _id };
  } catch (err) {
    // /api/1/users/email@host.com
    if (!domain && id.indexOf("@") > 0) {
      var email = id.split("@"); 
      id = email[0];
      domain = email[1];
    }
    query = { username: id, domain: domain };
  }

  var findOne = function(query) {
    return function(next) {
      Model.User.findOne(query, next);
    }
  }

  co(function*() {
    if (query.domain && !(ObjectId.isValid(query.domain) && typeof(query.domain) === "object")) {
      var domain = yield self.findDomainId(query.domain);
      if (domain && domain._id) {
        query.domain = domain._id;
      } else {
        return cb(null, {});
      }
    }

    var result = yield findOne(query);
    return cb(null, result);
  })();

}

User.prototype.create = function (ctx, options, cb) {

  var self = this;
  var body = options.body;
  body.object = "user";
  var createTransaction = function(next) {
     QueueModel.create({
       command: QueueCommands.types.CREATE,
       args: body,
       state: QueueStates.types.NEW,
       createdDate: new Date
     }, next); 
  }

  var register = function(err, result) {
    if (err) {
      return cb(err);
    }
    body.pendingTransaction = result._id;

    co(function*() {
      if (!(ObjectId.isValid(body.domain) && typeof(body.domain) === "object")) {
        var domain = yield self.findDomainId(body.domain);
        body.domain = domain._id;
      }
      if (body.group == null) {
        delete(body.group);
      }
      Model.User.register (body, function (err, data){

        if (err) {
          console.log(err);
          return cb (err);
        }

        if (!data) {
          // boom
        }

        var object = {
          object : "user",
        }

        var omit = ["hash", "log"];
        object = _.merge(object, data.toJSON());
        object = _.omit (object, omit);
        return cb (null, object);
      });
    })();
  }

  createTransaction(register);
}

User.prototype.update = function (ctx, options, cb) {

  var body = options.body;
  var id = ctx.params.id;

  var save = function(data) {
    delete data.log;
    data.save(function (err, user){

      if (err) return cb(boom.badRequest (err.message));

      var object = {
        object : "user",
      }

      var omit = ["hash", "log"];
      object = _.merge(object, user.toJSON());
      object = _.omit (object, omit);
      return cb (null, object);

    });
  }

  Model.User.findById(id, function(err, data){
    if (err) {
      return cb (err);
    }

    if (!data) {
      // boom
    }

    for (var k in body) {
      if (body[k]) {
        data[k] = body[k];  
      }
    }

    if (body.password) {
      data.setPassword(body.password, function() {
        save(data);
      });
    } else {
      save(data);
    }

  });
}


User.prototype.activate = function (ctx, options, cb) {

  var body = options.body || {};
  var params = ctx.params || [];

  var secret = body.secret || params.secret;

  Model.User.activate (secret, function (err, data){

    if (err) {
      return cb (err);
    }

    if (!data) {
      // boom
    }

    var object = {
      object : "user",
      _id : data._id,
      state : data.state
    }

    return cb (null, object);

  });
}

User.prototype.remove = function (ctx, options, cb){
  if (ctx.params.id) {
    Model.User.remove({_id : ctx.params.id}, function(err){
      if (err) return cb (err);
      cb (null, {object : "user", _id : ctx.params._id})
    });
  }
  else {

    if (Array.isArray(ctx.query.ids)) {
      Model.User.remove({ _id: { $in : ctx.query.ids} }, function(err){
        if (err) return cb (err);
        cb (null, {object : "user", data : ctx.query.ids})
      });

    } else {
      return cb (boom.badRequest("invalid arguments"));
    }
  }
}

User.prototype.authenticate = function (ctx, options, cb) {
  
  var self = this;
  var body = options.body;
  var email = body.email;
  var password = body.password;
  var omit = options.omit || ["hash", "secret", "log"];
  var username;
  var domain;

  var id = email.split("@");

  var unauthorized = function(err) {
    return cb (boom.unauthorized ({ email : email, password : password, err : err }));
  }

  domain = id.pop();
  username = id.pop();

  co(function*() {
    if (!(ObjectId.isValid(domain) && typeof(domain) === "object")) {
      domain = yield self.findDomainId(domain);
      if (domain && domain._id) {
        domain = domain._id;
      } else {
        return unauthorized("Domain not recognized");
      }
    }

    Model.User.authenticate (username, domain, password, function (err, authenticated) {

      if (err) {
        unauthorized(err);
      }

      if (!authenticated) {
        return cb (boom.unauthorized ("not authenticated"));
      }

      var object = {
        object: "user"
      }

      object = _.merge(object, authenticated.toJSON());
      object = _.omit(object, omit);

      object.roles = authenticated.roles;

      return cb (null, object);
    });
  })();
}

User.prototype.account = function(ctx, options, cb){
  cb (null, ctx.session);
}

User.prototype.findDomainId = function(domain) {
  return function(cb) {
    DomainModel.Domain.findOne({name: domain}, cb);
  }
}



module.exports = function(options) {
  return thunkified (User(options));
}
